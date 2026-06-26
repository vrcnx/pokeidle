import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useGame } from "../state/GameContext";
import { PartyList } from "./PartyColumn";
import { ContextPanel } from "./ContextPanel";
import { TownMap } from "./TownMap";
import { MartTab, BagTab, PCTab, DexTab } from "./BottomTabs";
import {
  IconMap, IconCart, IconBackpack, IconMonitor, IconBook, IconHeart, IconPin,
} from "./Icon";

// Desktop left rail: a vertical icon-strip nav that switches the
// content pane between the major game surfaces. Replaces the old
// fixed Party + ContextPanel column AND the BottomTabs strip that
// used to live under the battle scene — together those left the
// player flipping between a left-column scroll and a center-column
// tab strip to find what they wanted. One unified nav reads cleaner.
//
// The "World" tab combines the contextual location panel (encounters,
// gym, raids) with the town map via an internal sub-toggle, mirroring
// the mobile shell's World tab so the two layouts feel consistent.
type LeftTab = "world" | "party" | "mart" | "bag" | "pc" | "dex";

const TABS: { id: LeftTab; label: string; icon: ReactNode }[] = [
  { id: "world", label: "World", icon: <IconMap size={18} /> },
  { id: "party", label: "Party", icon: <IconHeart size={18} /> },
  { id: "mart",  label: "Mart",  icon: <IconCart size={18} /> },
  { id: "bag",   label: "Bag",   icon: <IconBackpack size={18} /> },
  { id: "pc",    label: "PC",    icon: <IconMonitor size={18} /> },
  { id: "dex",   label: "Dex",   icon: <IconBook size={18} /> },
];

export function LeftNav() {
  const { state } = useGame();
  const [tab, setTab] = useState<LeftTab>("world");
  const [worldView, setWorldView] = useState<"here" | "map">("here");

  // Auto-hop to "World → Here" the first time a boss battle starts so
  // the player notices the new contextual card. Mirrors the
  // MobileShell behaviour. Subsequent boss battles don't yank the
  // user — only the transition into the boss phase.
  const lastBossPhase = useRef(state.phase === "bossBattle");
  useEffect(() => {
    const isBoss = state.phase === "bossBattle";
    if (isBoss && !lastBossPhase.current) {
      setTab("world");
      setWorldView("here");
    }
    lastBossPhase.current = isBoss;
  }, [state.phase]);

  return (
    <div className="left-nav-column">
      <nav className="left-nav-strip" role="tablist" aria-label="Game sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            className={`left-nav-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.label}
          >
            <span className="left-nav-tab-icon">{t.icon}</span>
            <span className="left-nav-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>

      <div className={`left-nav-body left-nav-body-${tab}`}>
        {tab === "world" && (
          <div className="left-nav-pane world-pane">
            <div className="left-nav-subtabs" role="tablist" aria-label="World view">
              <button
                role="tab"
                aria-selected={worldView === "here"}
                className={worldView === "here" ? "active" : ""}
                onClick={() => setWorldView("here")}
              >
                <IconPin size={13} /> <span>Here</span>
              </button>
              <button
                role="tab"
                aria-selected={worldView === "map"}
                className={worldView === "map" ? "active" : ""}
                onClick={() => setWorldView("map")}
              >
                <IconMap size={13} /> <span>Map</span>
              </button>
            </div>
            <div className="left-nav-pane-body">
              {worldView === "here" ? <ContextPanel /> : <TownMap />}
            </div>
          </div>
        )}
        {tab === "party" && (
          <div className="left-nav-pane party-pane">
            <PartyList />
          </div>
        )}
        {tab === "mart" && (
          <div className="left-nav-pane bottom-tab-body"><MartTab /></div>
        )}
        {tab === "bag" && (
          <div className="left-nav-pane bottom-tab-body"><BagTab /></div>
        )}
        {tab === "pc" && (
          <div className="left-nav-pane bottom-tab-body"><PCTab /></div>
        )}
        {tab === "dex" && (
          <div className="left-nav-pane bottom-tab-body"><DexTab /></div>
        )}
      </div>
    </div>
  );
}
