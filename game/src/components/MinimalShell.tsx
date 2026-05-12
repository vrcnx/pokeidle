import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { UnlockHint } from "./ContextPanel";
import { TownMap } from "./TownMap";
import { MartTab, BagTab, PCTab, DexTab } from "./BottomTabs";
import { PartyList } from "./PartyColumn";
import { MiniChat } from "./MiniChat";
import { SocialPanel } from "./SocialPanel";
import { RailContext } from "./RailContext";
import { openPvpHub } from "./PvpHubModal";
import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
import { routes } from "../data/routes";
import { gymLeaders } from "../data/gymLeaders";
import {
  IconBackpack, IconMap, IconUsers, IconSettings, IconSwords, IconClose,
  IconCart, IconMonitor, IconBook, IconCoin, IconMedal,
} from "./Icon";

// "Minimal" desktop shell. Replaces the 3-column dashboard with a
// fullscreen game-view background and floating UI overlays:
//
//   - Top bar:    brand + section nav (World / Party / Inventory /
//                 Map / Quests) + right-side action icons (PvP /
//                 Friends / Notifications / Settings).
//   - Left rail:  always-visible party panel, transparent so the
//                 game scene reads through.
//   - Bottom:     action bar (moves toolbar + moves grid) — the
//                 only persistent input affordance on the screen.
//   - Right edge: subtle chat hint that slides the chat in on click
//                 or ENTER.
//   - Overlays:   clicking a top-nav section opens a centered card
//                 with that section's body — the underlying battle
//                 keeps running so idle ticks aren't paused.
//
// Hotkeys:
//   - TAB    → toggle the Party section (matches the [TAB] hint).
//   - ENTER  → toggle the chat slide-in (the C-Chat hint).
//   - ESC    → close whichever overlay is currently open.
// What can be popped open as a fullscreen overlay. Trimmed from the
// previous nav-menu list — World / Party / Quests aren't tabs
// anymore because their content lives in the always-visible right
// rail (encounters / phase) or left rail (party / next goal). Only
// the deep-dive surfaces stay overlay-shaped: Map / Bag / PC / Dex
// / Mart / Settings.
type Section =
  | "map"
  | "bag"
  | "pc"
  | "dex"
  | "mart"
  | "settings"
  | null;

export function MinimalShell() {
  const { state } = useGame();
  const { me } = useAuth();
  const [section, setSection] = useState<Section>(null);
  const [socialOpen, setSocialOpen] = useState(false);

  const here = routes[state.currentLocation];
  const phaseLabel = battlePhaseLabel(state);

  // Global hotkeys. Skip when the user is typing into a form field
  // (chat input, search bars, etc.) so ENTER doesn't get swallowed
  // mid-message.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      const isFormEl = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t as HTMLElement | null)?.isContentEditable;
      if (e.key === "Escape") {
        if (section) { setSection(null); return; }
        if (socialOpen) { setSocialOpen(false); return; }
      }
      if (isFormEl) return;
      if (e.key === "m" && !e.repeat) {
        setSection((s) => (s === "map" ? null : "map"));
      } else if (e.key === "b" && !e.repeat) {
        setSection((s) => (s === "bag" ? null : "bag"));
      } else if (e.key === "p" && !e.repeat) {
        setSection((s) => (s === "pc" ? null : "pc"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [socialOpen, section]);

  const partyCount = state.party.length;

  return (
    <div className="ms-shell">
      {/* Game scene — bounded centre cell. The outer .ms-game-bg fills
          the grid cell and centres the frame; the inner .ms-game-frame
          enforces a strict 16:9 aspect ratio so the BattleScene always
          renders at the canonical Pokémon viewport ratio. The cell
          letterboxes around the frame whenever the cell's own ratio
          drifts from 16:9. Two HUD chips float over the frame's top
          corners so the player always knows WHERE they are and WHAT
          phase the battle is in, without having to read the typewriter
          line at the bottom of the scene. */}
      <div className="ms-game-bg">
        <div className="ms-game-frame">
          <BattleScene />
          {/* Single phase chip on the top-right of the frame —
              role=status + aria-live=polite so screen readers
              announce phase transitions ("Wild battle" → "Trainer
              battle") without the user having to poll. */}
          <div
            className={`ms-hud ms-hud-tr ms-hud-phase phase-${state.phase}`}
            role="status"
            aria-live="polite"
            aria-label={`Phase: ${phaseLabel}`}
          >
            <span className="ms-hud-dot" aria-hidden />
            <span>{phaseLabel}</span>
          </div>
        </div>
      </div>

      {/* Top bar — brand + persistent stats + utility icons. The
          verbose World/Party/Inventory/Map/Quests text menu is
          gone — Map/Bag/PC/Dex are now compact icons (M / B / P
          hotkeys), Party + World moved into always-visible side
          rails. Fewer menus, more game-screen real estate. */}
      <header className="ms-top-bar">
        <div className="ms-brand" title="Pokémon Idle">
          <img src="/logos/pokeidle-icon.svg" alt="" aria-hidden />
          <span className="ms-brand-mark">POKÉIDLE</span>
        </div>
        <div className="ms-stats" aria-label="Status">
          <span className="ms-stat" title={`$${state.money.toLocaleString()}`}>
            <IconCoin size={13} strokeWidth={1.6} />
            <strong>{compactMoney(state.money)}</strong>
          </span>
          <span className="ms-stat" title={`${state.defeatedGyms.length} of ${gymLeaders.length} badges`}>
            <IconMedal size={13} strokeWidth={1.6} />
            <strong>{state.defeatedGyms.length}<small>/{gymLeaders.length}</small></strong>
          </span>
          {me && (
            <span className="ms-stat ms-stat-level" title={`Trainer level ${me.accountLevel}`}>
              <span className="ms-stat-lv">LV</span>
              <strong>{me.accountLevel}</strong>
            </span>
          )}
        </div>
        {/* Utility icon row — icon + visible label per button.
            Labels make the UI self-explanatory for new players and
            give screen readers an accessible name. Touch targets
            sized to ≥44×44. Each toggle exposes aria-pressed so
            assistive tech announces state changes. */}
        <nav className="ms-actions" aria-label="Game actions">
          <button
            className={`ms-icon-btn ${section === "map" ? "active" : ""}`}
            aria-label="Open Map (hotkey: M)"
            aria-pressed={section === "map"}
            onClick={() => setSection((s) => (s === "map" ? null : "map"))}
          >
            <IconMap size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">Map</span>
          </button>
          <button
            className={`ms-icon-btn ${section === "bag" ? "active" : ""}`}
            aria-label="Open Bag (hotkey: B)"
            aria-pressed={section === "bag"}
            onClick={() => setSection((s) => (s === "bag" ? null : "bag"))}
          >
            <IconBackpack size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">Bag</span>
          </button>
          <button
            className={`ms-icon-btn ${section === "pc" ? "active" : ""}`}
            aria-label="Open PC — Pokémon storage (hotkey: P)"
            aria-pressed={section === "pc"}
            onClick={() => setSection((s) => (s === "pc" ? null : "pc"))}
          >
            <IconMonitor size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">PC</span>
          </button>
          <button
            className={`ms-icon-btn ${section === "dex" ? "active" : ""}`}
            aria-label="Open Pokédex"
            aria-pressed={section === "dex"}
            onClick={() => setSection((s) => (s === "dex" ? null : "dex"))}
          >
            <IconBook size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">Dex</span>
          </button>
          <span className="ms-actions-sep" aria-hidden />
          <button
            className="ms-icon-btn"
            aria-label="PvP — battle other players"
            onClick={openPvpHub}
          >
            <IconSwords size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">PvP</span>
          </button>
          <button
            className="ms-icon-btn"
            aria-label="Friends and social"
            aria-pressed={socialOpen}
            onClick={() => setSocialOpen((o) => !o)}
          >
            <IconUsers size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">Friends</span>
          </button>
          <button
            className={`ms-icon-btn ${section === "settings" ? "active" : ""}`}
            aria-label="Open Settings"
            aria-pressed={section === "settings"}
            onClick={() => setSection((s) => (s === "settings" ? null : "settings"))}
          >
            <IconSettings size={16} strokeWidth={1.6} />
            <span className="ms-icon-btn-label">Settings</span>
          </button>
        </nav>
      </header>

      {/* Left rail — always-visible party + next-goal card. The
          UnlockHint slot at the bottom replaces the empty void
          below the party rows so the rail reads as a useful
          summary column rather than a half-filled dark panel. */}
      <aside className="ms-party-rail" aria-label="Party">
        <header className="ms-party-rail-head">
          <span className="ms-party-rail-title">Party</span>
          <span className="ms-party-rail-count">{partyCount}/6</span>
        </header>
        <div className="ms-party-rail-body">
          <PartyList />
        </div>
        <div className="ms-party-rail-goal">
          <UnlockHint />
        </div>
      </aside>

      {/* Bottom action bar — moves panel + toolbar, restyled to a
          transparent overlay. Sits centered over the game scene. */}
      <div className="ms-action-bar">
        <MovesToolbar />
        <MovesPanel />
      </div>

      {/* Right rail — top half: compact "Here" strip showing the
          location + encounter sprites or a single action CTA
          (Challenge Gym / Begin Raid / Enter League). The heavy
          interactive UI (raid tier picker, gym leader card with
          full team, league card) opens via the CTA in a focused
          modal — keeps the rail clean. Bottom half: live chat. */}
      <aside className="ms-right-rail" aria-label="Context">
        <div className="ms-right-rail-context">
          <header className="ms-rail-section-head">
            <span>Here</span>
          </header>
          <div className="ms-right-rail-context-body">
            <RailContext />
          </div>
        </div>
        <div className="ms-right-rail-chat">
          <header className="ms-rail-section-head">
            <span>Chat</span>
          </header>
          <div className="ms-right-rail-chat-body">
            <MiniChat />
          </div>
        </div>
      </aside>

      {/* Section overlay — only the deep-dive surfaces (Map / Bag /
          PC / Dex / Mart / Settings) can pop here. World / Party /
          Quests are gone — their content is on screen at all times. */}
      {section && (
        <div
          className={`ms-section-scrim ms-section-${section}`}
          onClick={() => setSection(null)}
        >
          <div
            className="ms-section-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={section}
          >
            <header className="ms-section-head">
              <span className="ms-section-icon">{sectionIcon(section)}</span>
              <h3>{sectionLabel(section)}</h3>
              <button
                className="ms-section-close"
                onClick={() => setSection(null)}
                aria-label="Close"
              >
                <IconClose size={16} strokeWidth={1.8} />
              </button>
            </header>
            <div className="ms-section-body">
              {section === "map"      && <TownMap />}
              {section === "bag"      && <BagTab />}
              {section === "pc"       && <PCTab />}
              {section === "dex"      && <DexTab />}
              {section === "mart"     && <MartTab />}
              {section === "settings" && <SettingsBody onJump={setSection} />}
            </div>
          </div>
        </div>
      )}

      {/* Reuse existing Social panel (slide drawer) */}
      <SocialPanel open={socialOpen} onClose={() => setSocialOpen(false)} />
    </div>
  );
}

// Compact money formatter — the top-bar chip can't fit a full
// "$12,345" so this falls through to "$12.3K" / "$1.2M" past the
// thousands threshold.
function compactMoney(n: number): string {
  if (n < 1_000) return `$${n}`;
  if (n < 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000) return `$${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(n / 1_000_000)}M`;
}

// One-line phase label for the top-right HUD chip on the game scene.
// Tells the player at a glance whether they're in a wild encounter,
// trainer fight, boss queue, or just idling — info that used to live
// only in the typewriter status line at the bottom of the scene.
function battlePhaseLabel(state: ReturnType<typeof useGame>["state"]): string {
  switch (state.phase) {
    case "battle":         return "Wild battle";
    case "trainerBattle":  return "Trainer battle";
    case "bossBattle":     return "Boss battle";
    case "raid":           return "Raid";
    case "victory":        return "Victory";
    case "evolution":      return "Evolving";
    case "healing":        return "Healing";
    case "starterSelect":  return "Choose a starter";
    case "idle":
    default:               return "Exploring";
  }
}

// Friendly title for the section overlay header.
function sectionLabel(s: NonNullable<Section>): string {
  switch (s) {
    case "map":      return "World Map";
    case "bag":      return "Bag";
    case "pc":       return "Pokémon Storage";
    case "dex":      return "Pokédex";
    case "mart":     return "Mart";
    case "settings": return "Settings";
  }
}

function sectionIcon(s: NonNullable<Section>): ReactNode {
  switch (s) {
    case "map":      return <IconMap size={16} strokeWidth={1.6} />;
    case "bag":      return <IconBackpack size={16} strokeWidth={1.6} />;
    case "pc":       return <IconMonitor size={16} strokeWidth={1.6} />;
    case "dex":      return <IconBook size={16} strokeWidth={1.6} />;
    case "mart":     return <IconCart size={16} strokeWidth={1.6} />;
    case "settings": return <IconSettings size={16} strokeWidth={1.6} />;
  }
}

// Settings overlay body — quick-access tiles that jump to the other
// section overlays (PC, Dex, Mart) plus a placeholder. Full settings
// modal rework is out of scope for the minimal-shell pass; keep the
// existing Settings modal reachable via the dock for now.
function SettingsBody({ onJump }: { onJump: (s: Section) => void }) {
  return (
    <div className="ms-settings-grid">
      <button className="ms-settings-tile" onClick={() => onJump("pc")}>
        <IconMonitor size={20} strokeWidth={1.5} />
        <strong>PC</strong>
        <span>Pokémon storage</span>
      </button>
      <button className="ms-settings-tile" onClick={() => onJump("dex")}>
        <IconBook size={20} strokeWidth={1.5} />
        <strong>Pokédex</strong>
        <span>Caught / seen records</span>
      </button>
      <button className="ms-settings-tile" onClick={() => onJump("mart")}>
        <IconCart size={20} strokeWidth={1.5} />
        <strong>Mart</strong>
        <span>Buy items in town</span>
      </button>
      <p className="ms-settings-note">
        Full preferences (audio, profanity filter, account, legal) are
        in the gear menu — coming next pass.
      </p>
    </div>
  );
}
