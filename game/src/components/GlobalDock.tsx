import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { hasShinyCharm } from "../utils/shinyCharm";
import { caughtObtainableCount, obtainableCount } from "../utils/obtainable";
import { regions, regionForLocation, DEFAULT_REGION } from "../data/regions";
import { regionBadgeCount, regionEliteFourCount } from "../utils/unlocks";
import { useAuth } from "../auth/AuthContext";
import { SocialPanel } from "./SocialPanel";
import { openLegal } from "./LegalModal";
import { openReportBug } from "./ReportBugModal";
import { openAchievements } from "./AchievementsModal";
import { openChangelog } from "./ChangelogModal";
import { openHowToPlay } from "./HowToPlayModal";
import { openDailyReward } from "../state/dailies";
import { useDailyStatus } from "../state/dailies";
import { openGiveaways } from "./GiveawayModal";
import { CURRENT_VERSION } from "../data/changelog";
import { IconSettings, IconChat, IconHeart, IconSwords } from "./Icon";
import { usePvpState } from "../state/pvp";
import { useIncomingRequestCount } from "../state/friendRequests";
import { useLayoutMode, setLayoutMode, type LayoutMode } from "../state/layoutMode";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { openPvpHub } from "./PvpHubModal";
import { useModalEnter, CountUp } from "../utils/animate";
import { isProfanityFilterOn, setProfanityFilter, subscribeProfanityFilter } from "../utils/profanity";
import { musicManager, type PublicState as MusicState } from "../utils/music";
import { sfxManager } from "../utils/sfx";
import { LANGUAGES, getLanguage, setLanguage, subscribeLanguage, type Language } from "../i18n/language";
import { useT } from "../i18n/useT";
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
  const t = useT();
  return (
    <div className="dock dock-gameplay" role="toolbar" aria-label={t("Gameplay actions")}>
      <DockButton
        icon={<IconHeart size={18} />}
        label={t("Heal")}
        title={t("Fully heal party. Bails out of any active battle / raid.")}
        onClick={() => dispatch({ type: "HEAL_PARTY" })}
      />
    </div>
  );
}

// Right dock — Settings + Social + PvP. Mounts the modals/panels that those buttons open.
export function MetaDock() {
  const [open, setOpen] = useOpen();
  const pvp = usePvpState();
  const t = useT();
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
      <div className="dock dock-meta" role="toolbar" aria-label={t("Account actions")}>
        <DockButton
          icon={<IconSwords size={18} />}
          label={t("PvP")}
          title={inBattle ? t("Already in a PvP battle") : t("PvP — battle other players")}
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
          label={t("Settings")}
          active={open === "settings"}
          onClick={() => setOpen(open === "settings" ? null : "settings")}
        />
        <DockButton
          icon={<IconChat size={18} />}
          label={t("Social")}
          active={open === "social"}
          title={incomingRequests > 0
            ? `${t("Friends & chat")} · ${incomingRequests} ${incomingRequests === 1 ? t("pending request") : t("pending requests")}`
            : t("Friends & chat")}
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
  const t = useT();

  const onVolChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    musicManager.setVolume(parseFloat(e.target.value) / 100);
  };
  const toggle = () => musicManager.setEnabled(!state.enabled);

  const label = state.currentTrack
    ? state.currentTrack.replace(/\.mp3$/i, "")
    : state.category
      ? t("Loading…")
      : t("Stopped");

  return (
    <section className="g-card">
      <h3>{t("Audio")}</h3>
      <div className="g-row">
        <span>{t("Music")}</span>
        <strong className={state.enabled ? "g-tag on" : "g-tag off"}>
          {state.enabled ? t("On") : t("Muted")}
        </strong>
      </div>
      <div className="audio-volume-row">
        <span className="dim small">{t("Volume")}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(state.volume * 100)}
          onChange={onVolChange}
          aria-label={t("Music volume")}
          disabled={!state.enabled}
        />
        <span className="audio-volume-pct">{Math.round(state.volume * 100)}</span>
      </div>
      <p className="g-help" style={{ marginTop: 4 }}>
        {t("Now playing:")} <em>{label}</em>
        {state.waitingForGesture && t(" — tap anywhere to start")}
      </p>
      <div className="settings-legal-links">
        <button className="g-btn-ghost g-btn-small" onClick={toggle}>
          {state.enabled ? t("Mute music") : t("Unmute music")}
        </button>
        {state.enabled && state.category && (
          <button className="g-btn-ghost g-btn-small" onClick={() => musicManager.next()}>
            {t("Skip track")}
          </button>
        )}
      </div>

      {/* Sound effects — separate volume + toggle so the player can
          mute the music background but keep the punchy attack SFX,
          or vice versa. */}
      <div className="audio-section-divider" />
      <div className="g-row">
        <span>{t("Sound effects")}</span>
        <SfxToggle />
      </div>
      <SfxVolume />
    </section>
  );
}

function SfxToggle() {
  const [s, setS] = useState(() => sfxManager.snapshot());
  useEffect(() => sfxManager.subscribe(setS), []);
  const t = useT();
  return (
    <strong className={s.enabled ? "g-tag on" : "g-tag off"}>
      {s.enabled ? t("On") : t("Muted")}
    </strong>
  );
}

function SfxVolume() {
  const [s, setS] = useState(() => sfxManager.snapshot());
  useEffect(() => sfxManager.subscribe(setS), []);
  const t = useT();
  return (
    <>
      <div className="audio-volume-row">
        <span className="dim small">{t("Volume")}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(s.volume * 100)}
          onChange={(e) => sfxManager.setVolume(parseFloat(e.target.value) / 100)}
          aria-label={t("Sound effects volume")}
          disabled={!s.enabled}
        />
        <span className="audio-volume-pct">{Math.round(s.volume * 100)}</span>
      </div>
      <div className="settings-legal-links">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => sfxManager.setEnabled(!s.enabled)}
        >
          {s.enabled ? t("Mute SFX") : t("Unmute SFX")}
        </button>
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => sfxManager.play("attack")}
        >
          {t("Test attack")}
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
  const t = useT();
  return (
    <section className="g-card">
      <h3>{t("Chat")}</h3>
      <div className="g-row">
        <span>{t("Profanity filter")}</span>
        <strong className={on ? "g-tag on" : "g-tag off"}>{on ? t("On") : t("Off")}</strong>
      </div>
      <p className="g-help" style={{ marginTop: 4 }}>
        {t("Censors common slurs and strong language in global and area chat. Each filtered message has a \"show\" link if you want to read the original.")}
      </p>
      <div className="settings-legal-links">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => setProfanityFilter(!on)}
        >
          {on ? t("Turn off filter") : t("Turn on filter")}
        </button>
      </div>
    </section>
  );
}

// Language preference. Lives in Account since it's a device-level
// setting, not chat-specific — same localStorage pub/sub pattern as
// ChatPrefsCard above.
function LanguagePrefsCard() {
  const [lang, setLang] = useState<Language>(() => getLanguage());
  useEffect(() => subscribeLanguage(setLang), []);
  const t = useT();
  return (
    <section className="g-card">
      <h3>{t("Language")}</h3>
      <p className="g-help" style={{ marginTop: 0 }}>
        {t("Choose your preferred language for menus and game text. Pokémon, move, and item names stay in English for now.")}
      </p>
      <div className="settings-legal-links">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            className={l.code === lang ? "g-btn-primary g-btn-small" : "g-btn-ghost g-btn-small"}
            onClick={() => setLanguage(l.code)}
          >
            {l.label}
          </button>
        ))}
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
type SettingsTab = "stats" | "display" | "audio" | "chat" | "account";

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { state } = useGame();
  const { me, signOut } = useAuth();
  const dailyStatus = useDailyStatus();
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>("stats");
  // Count against what can actually be caught, not the raw pokemonTable size,
  // and count the player's registrations the same way. This panel used to
  // divide an unfiltered caught-count by 288 while the charm unlocked at 245,
  // so it told players "Catch all 288 Pokémon to unlock. 44 left." for a charm
  // that was one catch away. Both sides now come from the same derived set the
  // Dex tab's completion ring uses.
  const totalDex = obtainableCount();
  const caughtDex = caughtObtainableCount(state.pokedexCaught);
  const charm = hasShinyCharm(state);
  const dexPct = ((caughtDex / Math.max(1, totalDex)) * 100).toFixed(1);
  // Badges/Elite Four are shown per the player's CURRENT region — a flat
  // count across every region's roster would read "0/16" (or worse once
  // a 3rd region exists) for a player standing in Kanto with 0 Johto
  // progress, which is confusing next to the classic "8 badges" framing.
  const region = regions[regionForLocation(state.currentLocation) ?? DEFAULT_REGION] ?? regions[DEFAULT_REGION];
  const gymLeaders = region.gymLeaders;
  const eliteFour = region.eliteFour;
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
        aria-label={t("Settings")}
      >
        <header className="g-modal-head">
          <h2>{t("Settings")}</h2>
          <button className="g-modal-close" onClick={onClose} aria-label={t("Close")}>×</button>
        </header>

        {me && (
          <section className="g-profile-hero settings-hero">
            <div className="g-avatar">{initial}</div>
            <div className="g-profile-info">
              <div className="g-profile-name">{me.name ?? me.username}</div>
              <div className="g-profile-handle">@{me.username}</div>
            </div>
            <div className="g-profile-stats">
              <div className="g-stat-pill"><strong><CountUp value={me.accountLevel} /></strong><span>{t("Level")}</span></div>
              <div className="g-stat-pill"><strong>$<CountUp value={state.money} /></strong><span>{t("Money")}</span></div>
              <div className="g-stat-pill"><strong><CountUp value={regionBadgeCount(state, region)} />/{gymLeaders.length}</strong><span>{t("Badges")}</span></div>
            </div>
          </section>
        )}

        <nav className="settings-tabs" role="tablist" aria-label={t("Settings sections")}>
          <SettingsTabBtn label={t("Stats")}   tab="stats"   active={tab} onPick={setTab} />
          <SettingsTabBtn label={t("Display")} tab="display" active={tab} onPick={setTab} />
          <SettingsTabBtn label={t("Audio")}   tab="audio"   active={tab} onPick={setTab} />
          <SettingsTabBtn label={t("Chat")}    tab="chat"    active={tab} onPick={setTab} />
          <SettingsTabBtn label={t("Account")} tab="account" active={tab} onPick={setTab} />
        </nav>

        <div className="g-modal-body">
          <div className="g-grid">
            {tab === "stats" && (
              <>
                <section className="g-card">
                  <h3>{t("Pokédex")}</h3>
                  <div className="g-row"><span>{t("Caught")}</span><strong>{caughtDex}<span className="dim"> / {totalDex}</span></strong></div>
                  <div className="g-row"><span>{t("Completion")}</span><strong>{dexPct}%</strong></div>
                  <div className="g-row"><span>{t("Seen")}</span><strong>{state.pokedexSeen.length}</strong></div>
                  <div className="g-row"><span>{t("Shiny seen")}</span><strong>{state.shinySeen.length}</strong></div>
                  <div className="g-row"><span>{t("Shiny caught")}</span><strong>{state.shinyCaught.length}</strong></div>
                </section>

                <section className="g-card">
                  <h3>{t("Battles")}</h3>
                  <div className="g-row"><span>{t("Wild won")}</span><strong>{state.wildBattlesWon.toLocaleString()}</strong></div>
                  <div className="g-row"><span>{t("Trainer won")}</span><strong>{state.trainerBattlesWon.toLocaleString()}</strong></div>
                  <div className="g-row"><span>{t("Elite Four")}</span><strong>{regionEliteFourCount(state, region)}<span className="dim"> / {eliteFour.length}</span></strong></div>
                  <div className="g-row"><span>{t("Champion")}</span><strong>{state.championDefeated ? t("Defeated") : <span className="dim">{t("Pending")}</span>}</strong></div>
                </section>

                <section className="g-card">
                  <h3>{t("Giveaways")}</h3>
                  <p className="g-help" style={{ marginTop: 0 }}>
                    {t("Free prize draws — Master Balls, cash, and rare Pokemon. One entry each, drawn fairly, winners announced in global chat.")}
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-primary g-btn-small"
                      onClick={() => { onClose(); openGiveaways(); }}
                    >
                      🎁 {t("View giveaways")}
                    </button>
                    <button
                      className="g-btn-ghost g-btn-small"
                      onClick={() => { onClose(); openDailyReward(); }}
                    >
                      🔥 {t("Daily reward")}{dailyStatus && !dailyStatus.claimedToday && <span className="daily-claimable-dot" aria-label={t("claim available")} />}
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>{t("New here?")}</h3>
                  <p className="g-help" style={{ marginTop: 4 }}>
                    {t("A thirty-second guide to how the game works.")}
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-ghost g-btn-small"
                      onClick={() => { onClose(); openHowToPlay(); }}
                    >
                      {t("How to play")}
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>{t("What's new")}</h3>
                  <div className="g-row">
                    <span>{t("Version")}</span>
                    <strong className="g-mono">v{CURRENT_VERSION}</strong>
                  </div>
                  <p className="g-help" style={{ marginTop: 4 }}>
                    {t("Every update, newest first. We ship often — most of it comes straight from player reports.")}
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-ghost g-btn-small"
                      onClick={() => { onClose(); openChangelog(); }}
                    >
                      {t("View changelog")}
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>{t("Achievements")}</h3>
                  <p className="g-help" style={{ marginTop: 0 }}>
                    {t("Trophy gallery — track your unlocks across catches, battles, PvP, trading, and the story.")}
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-primary g-btn-small"
                      onClick={() => { onClose(); openAchievements(); }}
                    >
                      {t("Open trophy gallery")}
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>{t("Shiny Charm")}</h3>
                  <div className="g-row">
                    <span>{t("Status")}</span>
                    <strong className={charm ? "g-tag on" : "g-tag off"}>{charm ? t("Active") : t("Locked")}</strong>
                  </div>
                  <p className="g-help">
                    {charm
                      ? t("In your Bag — shiny encounter rate is doubled (1/4096).")
                      : `${t("Catch all")} ${totalDex} ${t("Pokémon to unlock.")} ${Math.max(0, totalDex - caughtDex)} ${t("left.")}`}
                  </p>
                </section>
              </>
            )}

            {tab === "display" && <LayoutPrefsCard />}
            {tab === "audio" && <AudioPrefsCard />}
            {tab === "chat" && <ChatPrefsCard />}

            {tab === "account" && (
              <>
                {me && (
                  <section className="g-card">
                    <h3>{t("Account")}</h3>
                    <div className="g-row"><span>{t("Email")}</span><strong className="g-mono">{me.email}</strong></div>
                    <div className="g-row"><span>{t("Caught levels")}</span><strong>{me.totalCaughtLevels.toLocaleString()}</strong></div>
                    <div className="g-row"><span>{t("Joined")}</span><strong>{new Date(me.createdAt).toLocaleDateString()}</strong></div>
                  </section>
                )}

                <LanguagePrefsCard />

                <section className="g-card">
                  <h3>{t("Help & Feedback")}</h3>
                  <p className="g-help" style={{ marginTop: 0 }}>
                    {t("Found a bug or have feedback? Send a quick report and the team will look at it. Includes a snapshot of your party and last few battle log lines so we can reproduce.")}
                  </p>
                  <div className="settings-legal-links">
                    <button
                      className="g-btn-primary g-btn-small"
                      onClick={() => { onClose(); openReportBug(); }}
                    >
                      {t("Report a bug")}
                    </button>
                  </div>
                </section>

                <section className="g-card">
                  <h3>{t("Legal")}</h3>
                  <p className="g-help" style={{ marginTop: 0 }}>
                    {t("Unofficial fan project. Not affiliated with, endorsed by, or sponsored by Nintendo, Game Freak, or The Pokémon Company. Non-commercial; no copyrighted Pokémon assets are stored on our servers.")}
                  </p>
                  <div className="settings-legal-links">
                    <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("terms")}>{t("Terms of Service")}</button>
                    <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("privacy")}>{t("Privacy")}</button>
                    <button className="g-btn-ghost g-btn-small" onClick={() => openLegal("disclaimer")}>{t("Fan-Game Disclaimer")}</button>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>

        {me && (
          <footer className="g-modal-foot">
            <button className="g-btn-danger-ghost" onClick={signOut}>{t("Sign out")}</button>
            <button className="g-btn-primary" onClick={onClose}>{t("Close")}</button>
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

// Desktop layout picker. Wide is a SECONDARY layout: classic remains the
// default and nobody's view changes unless they pick it here. Hidden on
// small screens, where the mobile shell renders instead and the choice
// would do nothing.
function LayoutPrefsCard() {
  const t = useT();
  const mode = useLayoutMode();
  const isMobile = useMediaQuery("(max-width: 900px)");
  const OPTIONS: { id: LayoutMode; label: string; blurb: string }[] = [
    { id: "classic", label: t("Classic"), blurb: t("Centred, fixed-width columns. The original layout.") },
    { id: "wide", label: t("Wide"), blurb: t("Default. Uses the full screen width and grows the battle view. Best above 1200px.") },
  ];
  return (
    <section className="g-card">
      <h3>{t("Layout")}</h3>
      {isMobile && (
        <p className="g-help" style={{ marginTop: 0 }}>
          {t("This setting applies to the desktop layout — your screen is using the mobile view.")}
        </p>
      )}
      <div className="layout-pref-options">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`layout-pref-option ${mode === o.id ? "active" : ""}`}
            aria-pressed={mode === o.id}
            onClick={() => setLayoutMode(o.id)}
          >
            <span className={`layout-pref-preview layout-pref-preview-${o.id}`} aria-hidden>
              <span /><span /><span />
            </span>
            <strong>{o.label}</strong>
            <span className="dim small">{o.blurb}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
