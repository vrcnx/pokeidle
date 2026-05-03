import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { gymLeaders } from "../data/gymLeaders";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { TownMap } from "./TownMap";
import { PartyColumn } from "./PartyColumn";
import { ContextPanel } from "./ContextPanel";
import { BagTab, PCTab, MartTab } from "./BottomTabs";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";
import {
  IconPin, IconBag, IconMap, IconChat, IconBackpack, IconMonitor, IconCart,
} from "./Icon";

// Mobile single-column layout. Battle scene + moves are always pinned
// at the top; the bottom area swaps between six top-level tabs that
// match how the desktop dashboard organises content — without nested
// tab strips that confused the navigation before. Mart is accessed
// from the Map tab's location panel; Dex is in Settings → Trainer Card.
type MobileTab = "here" | "party" | "map" | "mart" | "bag" | "pc" | "chat";
const TABS: { id: MobileTab; label: string }[] = [
  { id: "here",  label: "Here" },
  { id: "party", label: "Party" },
  { id: "map",   label: "Map" },
  { id: "mart",  label: "Mart" },
  { id: "bag",   label: "Bag" },
  { id: "pc",    label: "PC" },
  { id: "chat",  label: "Chat" },
];

// Compact money formatter for the mobile header strip — keeps the
// stats row readable on narrow screens. The full amount is in the
// title attribute for anyone who wants the exact number.
function compactMoney(n: number): string {
  if (n < 1_000) return `$${n}`;
  if (n < 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000) return `$${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1_000_000)}M`;
}

function tabIcon(id: MobileTab) {
  switch (id) {
    case "here":  return <IconPin size={18} />;
    case "party": return <IconBag size={18} />;
    case "map":   return <IconMap size={18} />;
    case "mart":  return <IconCart size={18} />;
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
    <div className={`mobile-shell tab-${tab}`}>
      <header className="mobile-header">
        <div className="mobile-stats">
          <span title={`$${state.money.toLocaleString()}`}>
            <span className="mobile-stat-icon">💰</span>{compactMoney(state.money)}
          </span>
          <span title={`${state.defeatedGyms.length} of ${gymLeaders.length} badges`}>
            <span className="mobile-stat-icon">🏅</span>{state.defeatedGyms.length}/{gymLeaders.length}
          </span>
          {state.victoryTokens > 0 && (
            <span title={`${state.victoryTokens} Victory Tokens`}>
              <span className="mobile-stat-icon">🎟</span>{state.victoryTokens}
            </span>
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
        {/* Bag / Mart / PC reuse the desktop tab-body chrome (the
            parchment / tile / CRT-monitor backgrounds + frosted card
            styles defined under .bottom-tab-body:has(> .X-tab)). */}
        {tab === "mart"  && <div className="bottom-tab-body"><MartTab /></div>}
        {tab === "bag"   && <div className="bottom-tab-body"><BagTab /></div>}
        {tab === "pc"    && <div className="bottom-tab-body"><PCTab /></div>}
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
