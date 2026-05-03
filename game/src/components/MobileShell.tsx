import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { gymLeaders } from "../data/gymLeaders";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { TownMap } from "./TownMap";
import { PartyColumn } from "./PartyColumn";
import { ContextPanel } from "./ContextPanel";
import { BagTab, PCTab } from "./BottomTabs";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";
import {
  IconPin, IconBag, IconMap, IconChat, IconBackpack, IconMonitor,
} from "./Icon";

// Mobile single-column layout. Battle scene + moves are always pinned
// at the top; the bottom area swaps between six top-level tabs that
// match how the desktop dashboard organises content — without nested
// tab strips that confused the navigation before. Mart is accessed
// from the Map tab's location panel; Dex is in Settings → Trainer Card.
type MobileTab = "here" | "party" | "map" | "bag" | "pc" | "chat";
const TABS: { id: MobileTab; label: string }[] = [
  { id: "here",  label: "Here" },
  { id: "party", label: "Party" },
  { id: "map",   label: "Map" },
  { id: "bag",   label: "Bag" },
  { id: "pc",    label: "PC" },
  { id: "chat",  label: "Chat" },
];

function tabIcon(id: MobileTab) {
  switch (id) {
    case "here":  return <IconPin size={18} />;
    case "party": return <IconBag size={18} />;
    case "map":   return <IconMap size={18} />;
    case "bag":   return <IconBackpack size={18} />;
    case "pc":    return <IconMonitor size={18} />;
    case "chat":  return <IconChat size={18} />;
  }
}

export function MobileShell() {
  const { state } = useGame();
  const [tab, setTab] = useState<MobileTab>("here");

  // Auto-hop to "Here" on the FIRST entry into a boss battle (gym
  // leaders, E4, champion) so the player notices, but not on every
  // wild/trainer tick — those happen constantly and yanking the user
  // is annoying.
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
        {tab === "here"  && <ContextPanel />}
        {tab === "party" && <PartyColumn />}
        {tab === "map"   && <TownMap />}
        {tab === "bag"   && <BagTab />}
        {tab === "pc"    && <PCTab />}
        {tab === "chat"  && <MiniChat />}
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
