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
import { openAchievements } from "./AchievementsModal";
import { openChangelog } from "./ChangelogModal";
import { CURRENT_VERSION } from "../data/changelog";
import { IconSettings, IconChat, IconHeart, IconSwords } from "./Icon";
import { usePvpState } from "../state/pvp";
import { useIncomingRequestCount } from "../state/friendRequests";
import { openPvpHub } from "./PvpHubModal";
import { useModalEnter, CountUp } from "../utils/animate";
import { isProfanityFilterOn, setProfanityFilter, subscribeProfanityFilter } from "../utils/profanity";
import { musicManager, type PublicState as MusicState } from "../utils/music";
import { sfxManager } from "../utils/sfx";
import type { ReactNode } from "react";

// Action dock split across columns:
//   Left  (gameplay):  Heal — instant party heal
//   Right (meta):      Settings + Social + PvP
type PopupId = null | "settings" | "social" | "pvp";

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

// Right dock — Settings + Social + PvP. Mounts the modals/panels that those buttons open.
export function MetaDock() {
  const [open, setOpen] = useOpen();
  const pvp = usePvpState();
  // The PvP button is live-disabled mid-battle (nothing useful to do
  // from the hub then) but stays enabled while queueing — the queue
  // state is fine to inspect / leave from inside the hub.
  const inBattle = !!pvp.room;
  // Polls /api/friends every 30s; non-zero count lights up a badge
  // on the Social button so a fresh request is discoverable without
  // having to open the panel. (DrWhy: "socials tab does not light up
  // if a request is there unless you hit it" — fixed.)
  const { count: incomingRequests } = useIncomingRequestCount();
  return (
    <>
      <div className="dock dock-meta" role="toolbar" aria-label="Account actions">
        <DockButton
          icon={<IconSwords size={18} />}
          label="PvP"
          title={inBattle ? "Already in a PvP battle" : "PvP — battle other players"}
          onClick={() => {
            if (inBattle) return;
            // Hub is its own modal; close any other dock popup so we
            // don't stack overlays.
            setOpen(null);
            openPvpHub();
          }}
        />
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
          title={incomingRequests > 0
            ? `Friends & chat · ${incomingRequests} pending request${incomingRequests === 1 ? "" : "s"}`
            : "Friends & chat"}
          badge={incomingRequests}
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
  /** When > 0, paints a small red dot + count in the corner of the
   *  button. Used by the Social button for pending friend requests. */
  badge?: number;
  onClick: () => void;
}
// Audio preferences — master mute + volume slider. Lives next to the
// Chat card in the Settings modal. Subscribes to the music manager so
// the controls reflect any external state changes (e.g. autoplay
// finally unblocking on first user gesture).
function AudioPrefsCard() {
  const [state, setState] = useState<MusicState>(() => musicManager.snapshot());
  useEffect(() => musicManager.subscribe(setState), []);

  const onVolChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    musicManager.setVolume(parseFloat(e.target.value) / 100);
  };
  const toggle = () => musicManager.setEnabled(!state.enabled);

  const label = state.currentTrack
    ? state.currentTrack.replace(/\.mp3$/i, "")
    : state.category
      ? `Loading…`
      : "Stopped";

  return (
    <section className="g-card">
      <h3>Audio</h3>
      <div className="g-row">
        <span>Music</span>
        <strong className={state.enabled ? "g-tag on" : "g-tag off"}>
          {state.enabled ? "On" : "Muted"}
        </strong>
      </div>
      <div className="audio-volume-row">
        <span className="dim small">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(state.volume * 100)}
          onChange={onVolChange}
          aria-label="Music volume"
          disabled={!state.enabled}
        />
        <span className="audio-volume-pct">{Math.round(state.volume * 100)}</span>
      </div>
      <p className="g-help" style={{ marginTop: 4 }}>
        Now playing: <em>{label}</em>
        {state.waitingForGesture && " — tap anywhere to start"}
      </p>
      <div className="settings-legal-links">
        <button className="g-btn-ghost g-btn-small" onClick={toggle}>
          {state.enabled ? "Mute music" : "Unmute music"}
        </button>
        {state.enabled && state.category && (
          <button className="g-btn-ghost g-btn-small" onClick={() => musicManager.next()}>
            Skip track
          </button>
        )}
      </div>

      {/* Sound effects — separate volume + toggle so the player can
          mute the music background but keep the punchy attack SFX,
          or vice versa. */}
      <div className="audio-section-divider" />
      <div className="g-row">
        <span>Sound effects</span>
        <SfxToggle />
      </div>
      <SfxVolume />
    </section>
  );
}

function SfxToggle() {
  const [s, setS] = useState(() => sfxManager.snapshot());
  useEffect(() => sfxManager.subscribe(setS), []);
  return (
    <strong className={s.enabled ? "g-tag on" : "g-tag off"}>
      {s.enabled ? "On" : "Muted"}
    </strong>
  );
}

function SfxVolume() {
  const [s, setS] = useState(() => sfxManager.snapshot());
  useEffect(() => sfxManager.subscribe(setS), []);
  return (
    <>
      <div className="audio-volume-row">
        <span className="dim small">Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(s.volume * 100)}
          onChange={(e) => sfxManager.setVolume(parseFloat(e.target.value) / 100)}
          aria-label="Sound effects volume"
          disabled={!s.enabled}
        />
        <span className="audio-volume-pct">{Math.round(s.volume * 100)}</span>
      </div>
      <div className="settings-legal-links">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => sfxManager.setEnabled(!s.enabled)}
        >
          {s.enabled ? "Mute SFX" : "Unmute SFX"}
        </button>
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => sfxManager.play("attack")}
        >
          Test attack
        </button>
      </div>
    </>
  );
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

function DockButton({ icon, label, active, disabled, title, badge, onClick }: DockBtnProps) {
  return (
    <button
      type="button"
      className={`dock-btn ${active ? "active" : ""} ${badge && badge > 0 ? "has-badge" : ""}`}
      title={title ?? label}
      aria-label={badge && badge > 0 ? `${label} (${badge} new)` : label}
      aria-pressed={!!active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="dock-btn-icon">{icon}</span>
      <span className="dock-btn-label">{label}</span>
      {badge != null && badge > 0 && (
        <span className="dock-btn-badge" aria-hidden>{badge > 99 ? "99+" : badge}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Settings modal — split into four focused tabs to fix the previous
// kitchen-sink layout (the trainer record, audio, chat, account, legal,
// help and report-bug were all stacked in one ~400-line scroll). Tabs:
//   - Stats:    Pokédex / Battles / Shiny Charm record
//   - Audio:    music + sfx prefs
//   - Chat:     profanity filter + future chat prefs
//   - Account:  email / join date / sign out / report bug / legal
// Default tab is Stats since most opens are "check my progress".
// ---------------------------------------------------------------------------
type SettingsTab = "stats" | "audio" | "chat" | "account";

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { state } = useGame();
  const { me, signOut } = useAuth();
  const [tab, setTab] = useState<SettingsTab>("stats");
  const totalDex = Object.keys(pokemonTable).length;
  const charm = hasShinyCharm(state.pokedexCaught);
  const dexPct = ((state.pokedexCaught.length / totalDex) * 100).toFixed(1);
  const initial = (me?.name ?? me?.username ?? "?")[0]?.toUpperCase() ?? "?";
  const dialogRef = useModalEnter(".g-profile-hero, .g-card");

  // ESC dismisses — every modal in the codebase should.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

        {me && (
          <section className="g-profile-hero settings-hero">
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

        <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
          <SettingsTabBtn label="Stats"   tab="stats"   active={tab} onPick={setTab} />
          <SettingsTabBtn label="Audio"   tab="audio"   active={tab} onPick={setTab} />
          <SettingsTabBtn label="Chat"    tab="chat"    active={tab} onPick={setTab} />
          <SettingsTabBtn label="Account" tab="account" active={tab} onPick={setTab} />
        </nav>

        <div className="g-modal-body">
          <div className="g-grid">
            {tab === "stats" && (
              <>
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
                  <h3>What's new</h3>
                  <div className="g-row">
                    <span>Version</span>
                    <strong className="g-mono">v{CURRENT_VERSION}</strong>
                  </div>
                  <p className="g-help" style={{ marginTop: 4 }}>
                    Every update, newest first. We ship often — most of it comes
                    straight from player reports.
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-ghost g-btn-small"
                      onClick={() => { onClose(); openChangelog(); }}
                    >
                      View changelog
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>Achievements</h3>
                  <p className="g-help" style={{ marginTop: 0 }}>
                    Trophy gallery — track your unlocks across catches,
                    battles, PvP, trading, and the story.
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-primary g-btn-small"
                      onClick={() => { onClose(); openAchievements(); }}
                    >
                      Open trophy gallery
                    </button>
                  </div>
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
              </>
            )}

            {tab === "audio" && <AudioPrefsCard />}
            {tab === "chat" && <ChatPrefsCard />}

            {tab === "account" && (
              <>
                {me && (
                  <section className="g-card">
                    <h3>Account</h3>
                    <div className="g-row"><span>Email</span><strong className="g-mono">{me.email}</strong></div>
                    <div className="g-row"><span>Caught levels</span><strong>{me.totalCaughtLevels.toLocaleString()}</strong></div>
                    <div className="g-row"><span>Joined</span><strong>{new Date(me.createdAt).toLocaleDateString()}</strong></div>
                  </section>
                )}

                <section className="g-card">
                  <h3>Help &amp; Feedback</h3>
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
              </>
            )}
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

function SettingsTabBtn({
  label, tab, active, onPick,
}: {
  label: string;
  tab: SettingsTab;
  active: SettingsTab;
  onPick: (t: SettingsTab) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === tab}
      className={`settings-tab ${active === tab ? "active" : ""}`}
      onClick={() => onPick(tab)}
    >
      {label}
    </button>
  );
}

