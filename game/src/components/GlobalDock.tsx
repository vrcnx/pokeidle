import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { hasShinyCharm } from "../utils/pokemon";
import { gymLeaders } from "../data/gymLeaders";
import { eliteFour } from "../data/eliteFour";
import { useAuth } from "../auth/AuthContext";
import { SocialPanel } from "./SocialPanel";
import { openLegal } from "./LegalModal";
import { openReportBug } from "./ReportBugModal";
import { IconSettings, IconChat, IconHeart } from "./Icon";
import { useModalEnter, CountUp } from "../utils/animate";
import { isProfanityFilterOn, setProfanityFilter, subscribeProfanityFilter } from "../utils/profanity";
import type { ReactNode } from "react";

// Action dock split across columns:
//   Left  (gameplay):  Heal — instant party heal
//   Right (meta):      Settings + Social
type PopupId = null | "settings" | "social";

// Bus to coordinate state across the two dock components, since they're
// rendered in different columns now.
let openState: PopupId = null;
const openListeners = new Set<(o: PopupId) => void>();
function setOpenState(o: PopupId) {
  openState = o;
  for (const fn of openListeners) fn(o);
}
function useOpen(): [PopupId, (o: PopupId) => void] {
  const [o, setO] = useState<PopupId>(openState);
  useState(() => {
    openListeners.add(setO);
    return () => openListeners.delete(setO);
  });
  return [o, setOpenState];
}

// Left dock — only Heal lives here now.
export function GameplayDock() {
  const { dispatch } = useGame();
  return (
    <div className="dock dock-gameplay" role="toolbar" aria-label="Gameplay actions">
      <DockButton
        icon={<IconHeart size={18} />}
        label="Heal"
        title="Fully heal party. Bails out of any active battle / raid."
        onClick={() => dispatch({ type: "HEAL_PARTY" })}
      />
    </div>
  );
}

// Right dock — Settings + Social. Mounts the modals/panels that those buttons open.
export function MetaDock() {
  const [open, setOpen] = useOpen();
  return (
    <>
      <div className="dock dock-meta" role="toolbar" aria-label="Account actions">
        <DockButton
          icon={<IconSettings size={18} />}
          label="Settings"
          active={open === "settings"}
          onClick={() => setOpen(open === "settings" ? null : "settings")}
        />
        <DockButton
          icon={<IconChat size={18} />}
          label="Social"
          active={open === "social"}
          title="Friends & chat"
          onClick={() => setOpen(open === "social" ? null : "social")}
        />
      </div>
      {open === "settings" && <SettingsModal onClose={() => setOpen(null)} />}
      <SocialPanel open={open === "social"} onClose={() => setOpen(null)} />
    </>
  );
}

// Back-compat: legacy GlobalDock = both halves rendered in sequence (mobile uses this).
export function GlobalDock() {
  return <><GameplayDock /><MetaDock /></>;
}

interface DockBtnProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}
// Profanity-filter toggle. Lives inside the Settings modal as its own
// card so future chat preferences (mute lists, font size, etc.) have a
// home next to it.
function ChatPrefsCard() {
  const [on, setOn] = useState(() => isProfanityFilterOn());
  useEffect(() => subscribeProfanityFilter(setOn), []);
  return (
    <section className="g-card">
      <h3>Chat</h3>
      <div className="g-row">
        <span>Profanity filter</span>
        <strong className={on ? "g-tag on" : "g-tag off"}>{on ? "On" : "Off"}</strong>
      </div>
      <p className="g-help" style={{ marginTop: 4 }}>
        Censors common slurs and strong language in global and area chat.
        Each filtered message has a "show" link if you want to read the
        original.
      </p>
      <div className="settings-legal-links">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => setProfanityFilter(!on)}
        >
          {on ? "Turn off filter" : "Turn on filter"}
        </button>
      </div>
    </section>
  );
}

function DockButton({ icon, label, active, disabled, title, onClick }: DockBtnProps) {
  return (
    <button
      type="button"
      className={`dock-btn ${active ? "active" : ""}`}
      title={title ?? label}
      aria-label={label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="dock-btn-icon">{icon}</span>
      <span className="dock-btn-label">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Settings modal — a proper centered modal that's the single home for game
// controls (pause/speed/mode/auto-proceed), trainer info (Pokédex stats,
// shiny charm, battles, wallet), and the Reset save action. Designed to
// keep growing — new toggles/sections drop in here rather than the dock.
// ---------------------------------------------------------------------------
function SettingsModal({ onClose }: { onClose: () => void }) {
  const { state } = useGame();
  const { me, signOut } = useAuth();
  const totalDex = Object.keys(pokemonTable).length;
  const charm = hasShinyCharm(state.pokedexCaught);
  const dexPct = ((state.pokedexCaught.length / totalDex) * 100).toFixed(1);
  const initial = (me?.name ?? me?.username ?? "?")[0]?.toUpperCase() ?? "?";
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal settings-modal-v2"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <header className="g-modal-head">
          <h2>Settings</h2>
          <button className="g-modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="g-modal-body">
          {me && (
            <section className="g-profile-hero">
              <div className="g-avatar">{initial}</div>
              <div className="g-profile-info">
                <div className="g-profile-name">{me.name ?? me.username}</div>
                <div className="g-profile-handle">@{me.username}</div>
              </div>
              <div className="g-profile-stats">
                <div className="g-stat-pill"><strong><CountUp value={me.accountLevel} /></strong><span>Level</span></div>
                <div className="g-stat-pill"><strong>$<CountUp value={state.money} /></strong><span>Money</span></div>
                <div className="g-stat-pill"><strong><CountUp value={state.defeatedGyms.length} />/{gymLeaders.length}</strong><span>Badges</span></div>
              </div>
            </section>
          )}

          <div className="g-grid">
            <section className="g-card">
              <h3>Pokédex</h3>
              <div className="g-row"><span>Caught</span><strong>{state.pokedexCaught.length}<span className="dim"> / {totalDex}</span></strong></div>
              <div className="g-row"><span>Completion</span><strong>{dexPct}%</strong></div>
              <div className="g-row"><span>Seen</span><strong>{state.pokedexSeen.length}</strong></div>
              <div className="g-row"><span>Shiny seen</span><strong>{state.shinySeen.length}</strong></div>
              <div className="g-row"><span>Shiny caught</span><strong>{state.shinyCaught.length}</strong></div>
            </section>

            <section className="g-card">
              <h3>Battles</h3>
              <div className="g-row"><span>Wild won</span><strong>{state.wildBattlesWon.toLocaleString()}</strong></div>
              <div className="g-row"><span>Trainer won</span><strong>{state.trainerBattlesWon.toLocaleString()}</strong></div>
              <div className="g-row"><span>Elite Four</span><strong>{state.defeatedEliteFour.length}<span className="dim"> / {eliteFour.length}</span></strong></div>
              <div className="g-row"><span>Champion</span><strong>{state.championDefeated ? "Defeated" : <span className="dim">Pending</span>}</strong></div>
            </section>

            <section className="g-card">
              <h3>Shiny Charm</h3>
              <div className="g-row">
                <span>Status</span>
                <strong className={charm ? "g-tag on" : "g-tag off"}>{charm ? "Active" : "Locked"}</strong>
              </div>
              <p className="g-help">
                {charm
                  ? "Shiny encounter rate is doubled (1/4096)."
                  : `Catch all ${totalDex} Pokémon to unlock. ${totalDex - state.pokedexCaught.length} left.`}
              </p>
            </section>

            {me && (
              <section className="g-card">
                <h3>Account</h3>
                <div className="g-row"><span>Email</span><strong className="g-mono">{me.email}</strong></div>
                <div className="g-row"><span>Caught levels</span><strong>{me.totalCaughtLevels.toLocaleString()}</strong></div>
                <div className="g-row"><span>Joined</span><strong>{new Date(me.createdAt).toLocaleDateString()}</strong></div>
              </section>
            )}

            <ChatPrefsCard />

            <section className="g-card">
              <h3>Help & Feedback</h3>
              <p className="g-help" style={{ marginTop: 0 }}>
                Found a bug or have feedback? Send a quick report and the
                team will look at it. Includes a snapshot of your party
                and last few battle log lines so we can reproduce.
              </p>
              <div className="settings-legal-links">
                <button
                  className="g-btn-primary g-btn-small"
                  onClick={() => { onClose(); openReportBug(); }}
                >
                  Report a bug
                </button>
              </div>
            </section>

            <section className="g-card">
              <h3>Legal</h3>
              <p className="g-help" style={{ marginTop: 0 }}>
                Unofficial fan project. Not affiliated with, endorsed by, or
                sponsored by Nintendo, Game Freak, or The Pokémon Company.
                Non-commercial; no copyrighted Pokémon assets are stored on
                our servers.
              </p>
              <div className="settings-legal-links">
                <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("terms")}>Terms of Service</button>
                <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("privacy")}>Privacy</button>
                <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("disclaimer")}>Fan-Game Disclaimer</button>
              </div>
            </section>
          </div>
        </div>

        {me && (
          <footer className="g-modal-foot">
            <button className="g-btn-danger-ghost" onClick={signOut}>Sign out</button>
            <button className="g-btn-primary" onClick={onClose}>Close</button>
          </footer>
        )}
      </div>
    </div>
  );
}

