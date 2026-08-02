import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  IconMap, IconCart, IconBackpack, IconMonitor, IconBook,
  IconSwords, IconTicket, IconChat, IconSettings, IconMedal,
} from "./Icon";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import { useIncomingRequestCount } from "../state/friendRequests";
import { useGiveaways, seenWins } from "../utils/giveawayStore";
import { railState } from "../utils/giveawayRail";
import "./hub.css";

// The Hub — one dialog for everything that is not the game itself.
//
// ── WHY ─────────────────────────────────────────────────────────────
// PvP, Social, Settings and Rewards were four separate modals opened from
// three different places, each with its own overlay, header, close button,
// ESC handler and idea of what a tab looks like. Nothing about that is
// discoverable: answering "is there anything waiting for me?" meant opening
// two dialogs and closing two dialogs. There was no somewhere-to-go in this
// game, only a set of unrelated destinations that shared a toolbar.
//
// This is that somewhere. One overlay, one frame, one close button, and a
// left rail that says what exists — so the answer is visible from inside any
// section instead of requiring a tour.
//
// ── THE STRUCTURE RULE ──────────────────────────────────────────────
// The sidebar says WHICH AREA you are in. A horizontal .g-tab row at the top
// of the pane says WHICH VIEW within that area. Two levels, in that order,
// never a third.
//
// This is load-bearing, because three of the four sections arrived carrying
// their own tab rows — Settings six, Social three, Rewards three. Mounting
// the old Rewards dialog here unchanged would have nested a sidebar inside a
// sidebar, which is how a hub turns back into a maze.
//
// ── WHAT A SECTION IS ───────────────────────────────────────────────
// A pane, not a dialog: no overlay, no header, no close button, no ESC
// handler. Those belong to the frame, exactly once. A section supplies a
// body, optionally something for the right of the pane header, and a flag
// for whether it manages its own scrolling (chat does; a settings form
// does not).

export type HubSection =
  | "map" | "mart" | "bag" | "pc" | "dex"
  | "pvp" | "rewards" | "social" | "settings"
  // Reachable only by pressing the identity block at the top of the rail —
  // see `rail: false` below.
  | "trainer";

export interface HubSectionContent {
  /**
   * The pane. A COMPONENT rather than a rendered node, and that is the
   * load-bearing part of this contract: the frame mounts only the active
   * section, so an inactive one runs no hooks, opens no sockets and issues
   * no requests. Passing nodes instead would mean building all four on
   * every render of the hub — Social's chat subscription and Battle's queue
   * poll included — to display one of them.
   */
  Body: React.ComponentType;
  /** Rendered at the right of the pane header: a rating chip, a stat line.
   *  Also a component, mounted on the same terms as the body. */
  HeaderRight?: React.ComponentType;
  /** True when the section lays out to the pane's full height and scrolls
   *  its own subregions. Chat does this: an outer scroll would put the
   *  composer below the fold. */
  fill?: boolean;
  /** Optional one-line subtitle under the section title. */
  note?: string;
}

interface SectionDef {
  id: HubSection;
  /** The app's own icon set, not a unicode glyph. The glyphs (▣ ⛁ ⛃ ▤ ▥)
   *  were a placeholder that shipped: they render at whatever weight the
   *  font feels like, sit off the baseline, and look nothing like the
   *  drawn icons the tab strip used for the same five destinations. */
  Icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  group: "world" | "play" | "account";
  /** False for a section that is a real destination but NOT a row in the
   *  rail. The trainer card is the only one: its door is your own name and
   *  face at the top of the rail, which is a better door than a tenth row
   *  labelled "Trainer Card" directly underneath it. */
  rail?: false;
}

// Order is the priority order a player cares about, not alphabetical:
// the thing you do, then the thing you get, then the people, then the knobs.
const SECTIONS: SectionDef[] = [
  { id: "map",      Icon: IconMap,       label: "Map",      group: "world" },
  { id: "mart",     Icon: IconCart,      label: "Mart",     group: "world" },
  { id: "bag",      Icon: IconBackpack,  label: "Bag",      group: "world" },
  { id: "pc",       Icon: IconMonitor,   label: "PC",       group: "world" },
  { id: "dex",      Icon: IconBook,      label: "Pokédex",  group: "world" },
  { id: "pvp",      Icon: IconSwords,    label: "Battle",   group: "play" },
  { id: "rewards",  Icon: IconTicket,    label: "Rewards",  group: "play" },
  { id: "social",   Icon: IconChat,      label: "Social",   group: "account" },
  { id: "settings", Icon: IconSettings,  label: "Settings", group: "account" },
  { id: "trainer",  Icon: IconMedal,     label: "Trainer Card", group: "account", rail: false },
];

/** The rail's rows: every section except the ones with their own door. */
const RAIL = SECTIONS.filter((s) => s.rail !== false);

const GROUPS: Array<{ id: SectionDef["group"]; label: string }> = [
  { id: "world",   label: "Go" },
  { id: "play",    label: "Play" },
  { id: "account", label: "You" },
];

const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

// ── Open / close ────────────────────────────────────────────────────
// A module-level opener, matching the pattern of the dialogs it replaces
// (openGiveaways, openPvpHub). Callers name a SECTION rather than a dialog,
// which is the point: "show me rewards", not "mount the rewards modal".
let _open: ((section: HubSection | undefined) => void) | null = null;
let _close: (() => void) | null = null;

/** Open the hub. With no argument it lands on whatever has something
 *  waiting — see pickLanding below. */
export function openHub(section?: HubSection) { _open?.(section); }
export function closeHub() { _close?.(); }

// Which section is on screen, for anything outside the hub that needs to
// reflect it — the dock's three buttons light up the same way a tab does,
// so the toolbar and the rail always agree about where you are.
let _section: HubSection | null = null;
const _sectionListeners = new Set<(s: HubSection | null) => void>();
function publishSection(s: HubSection | null) {
  _section = s;
  for (const fn of _sectionListeners) fn(s);
}
export function useHubSection(): HubSection | null {
  const [s, set] = useState<HubSection | null>(_section);
  useEffect(() => {
    _sectionListeners.add(set);
    set(_section);
    return () => { _sectionListeners.delete(set); };
  }, []);
  return s;
}

export interface HubModalProps {
  sections: Record<HubSection, HubSectionContent>;
  /** Who the player is, for the top of the rail. A slot rather than
   *  something this file reads, so the frame still knows nothing about
   *  saves, auth or currency. */
  identity?: ReactNode;
  /** What pressing the identity block opens. Given, the frame wraps the
   *  identity in a button; omitted, it stays inert. A prop rather than a
   *  hardcoded "trainer" so the frame still knows nothing about what a
   *  trainer card is — hub-preview passes an identity with no section and
   *  gets the plain block. */
  identitySection?: HubSection;
  /** Sections that cannot be entered right now, with the reason. PvP is not
   *  useful mid-battle. */
  disabled?: Partial<Record<HubSection, string>>;
}

export function HubModal({ sections, disabled, identity, identitySection }: HubModalProps) {
  const [active, setActive] = useState<HubSection | null>(null);
  const badges = useHubBadges();
  const t = useT();

  // A ref, so the opener installed once on mount always reads today's
  // badges. Putting `badges` in the effect's deps instead would tear the
  // opener down and rebuild it on every poll tick, and a caller that grabbed
  // it mid-teardown would open nothing.
  const landingRef = useRef<HubSection>("pvp");
  landingRef.current = pickLanding(badges, disabled);

  useEffect(() => {
    _open = (s) => setActive(s ?? landingRef.current);
    _close = () => setActive(null);
    return () => { _open = null; _close = null; };
  }, []);

  // Mirror the open section outward for the dock. In an effect, not during
  // render: publishing synchronously would set state in the dock's
  // subscribers while this component is still rendering.
  useEffect(() => { publishSection(active); }, [active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setActive(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // A section can be disabled WHILE the player is standing in it — starting a
  // PvP battle from the Battle pane is the obvious case. Move them somewhere
  // usable rather than leaving them on a dead pane.
  useEffect(() => {
    if (active && disabled?.[active]) setActive(pickLanding(badges, disabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, disabled?.pvp, disabled?.rewards, disabled?.social, disabled?.settings]);

  if (!active) return null;
  return (
    <HubFrame
      active={active}
      onSelect={setActive}
      onClose={() => setActive(null)}
      sections={sections}
      disabled={disabled}
      badges={badges}
      identity={identity}
      identitySection={identitySection}
      title={t("Hub")}
    />
  );
}

/**
 * Where a bare `openHub()` lands.
 *
 * Ordered by how much the player is likely to care, and only ever on
 * something ACTIONABLE: a giveaway win or an uncollected reward, then a
 * pending friend request, then Battle as the neutral home. It never lands on
 * Settings, because nobody opens a hub hoping for the audio sliders.
 */
export function pickLanding(
  badges: Partial<Record<HubSection, number>>,
  disabled?: Partial<Record<HubSection, string>>,
): HubSection {
  const order: HubSection[] = ["rewards", "social", "pvp"];
  for (const id of order) if ((badges[id] ?? 0) > 0 && !disabled?.[id]) return id;
  // The map, not Battle. Once this dialog is the whole game menu the neutral
  // home is where you GO, and going somewhere is what a player opens a menu
  // to do far more often than starting a ranked match.
  if (!disabled?.map) return "map";
  return RAIL.find((s) => !disabled?.[s.id])?.id ?? "settings";
}

/**
 * The frame, with no opener and no global state.
 *
 * Split for the same reason RewardsDialog was: a hub is only interesting in
 * the states that are hard to reach — a pending friend request AND a live
 * giveaway AND a disabled Battle section, all at once — and that is not a
 * combination anyone can produce on demand in a real session. hub-preview.tsx
 * mounts this with the real stylesheet.
 */
export function HubFrame({
  active, onSelect, onClose, sections, disabled, badges, identity, identitySection, title,
}: {
  active: HubSection;
  onSelect: (s: HubSection) => void;
  onClose: () => void;
  sections: Record<HubSection, HubSectionContent>;
  disabled?: Partial<Record<HubSection, string>>;
  badges?: Partial<Record<HubSection, number>>;
  identity?: ReactNode;
  identitySection?: HubSection;
  title: string;
}) {
  const t = useT();
  const dialogRef = useModalEnter(".hub-pane");
  const navRef = useRef<HTMLDivElement | null>(null);
  const def = SECTION_BY_ID.get(active)!;
  const content = sections[active];

  // ── Focus ────────────────────────────────────────────────────────
  // Send focus into the dialog on open and give it back on close. The four
  // dialogs this replaced did neither, which meant a keyboard user opened
  // the hub and was still focused on the toolbar behind it — every Tab
  // walking the game underneath a modal they could see but not reach.
  //
  // The active rail tab is the target rather than the dialog itself: it is
  // where the arrow-key navigation starts, so one Tab press from there
  // reaches the pane and the rest of the rail is an arrow away.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    // Directly, not inside requestAnimationFrame. The DOM is already
    // committed by the time an effect runs, so the frame buys nothing — and
    // rAF does not fire at all in a backgrounded tab, which would silently
    // leave focus outside a modal that is demonstrably on screen.
    navRef.current?.querySelector<HTMLButtonElement>(".hub-tab.is-active")?.focus();
    return () => {
      // Only if the trigger is still on the page and nothing else has
      // deliberately taken focus in the meantime.
      if (returnTo?.isConnected && document.activeElement === document.body) {
        returnTo.focus();
      }
    };
    // Mount/unmount only — re-running per section would yank focus out of a
    // pane every time somebody switched view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep Tab inside the dialog. Without this, tabbing past the last control
  // in the pane lands on the game behind the overlay — reachable by keyboard,
  // invisible to the eye, and impossible to get back from without a mouse.
  const onTrapKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = [...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, [dialogRef]);

  // Arrow keys move between rail items, wrapping, skipping disabled ones —
  // the standard tablist interaction. Without it the rail is a set of tab
  // stops you have to Tab through one at a time, which is the difference
  // between a nav a keyboard user can fly and one they endure.
  const onNavKey = useCallback((e: React.KeyboardEvent) => {
    const keys = ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const usable = RAIL.filter((s) => !disabled?.[s.id]);
    if (usable.length === 0) return;
    const at = usable.findIndex((s) => s.id === active);
    const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1;
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? usable.length - 1
      : (at + step + usable.length) % usable.length;
    onSelect(usable[next].id);
    // Move focus with the selection, or the next arrow press starts from
    // wherever the DOM focus was left behind. The target button already
    // exists — selection only changes which one is styled active — so this
    // needs no frame either.
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-section="${usable[next].id}"]`)
      ?.focus();
  }, [active, disabled, onSelect]);

  return (
    // hub-overlay, because the shared overlay pins its children 8vh from the
    // top — a rule written for content-sized modals that jump when their body
    // grows. The hub is a fixed-height panel, so that reasoning does not apply
    // to it and it should sit in the middle of the screen like the destination
    // it is.
    <div className="modal-overlay hub-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal hub-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onTrapKey}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="hub-shell">
          <aside className="hub-side">
            {/* The player, not a logo. A hub's rail had a wordmark in it
                saying "Hub" — a label for the thing you are already looking
                at. Who you are, what level, how much money is the same space
                spent on something worth reading. */}
            {identity
              ? (identitySection
                ? (
                  // Your own name and face, as the way into your own card.
                  // Every other rail row is a place; this one is you, so it
                  // sits above the groups rather than inside "You".
                  <button
                    type="button"
                    className={`hub-me-btn${active === identitySection ? " is-active" : ""}`}
                    aria-current={active === identitySection ? "page" : undefined}
                    onClick={() => onSelect(identitySection)}
                    title={t("Trainer Card")}
                  >
                    {identity}
                  </button>
                )
                : identity)
              : (
              <div className="hub-brand">
                <span className="hub-brand-mark" aria-hidden>◆</span>
                <span className="hub-brand-text">{title}</span>
              </div>
            )}

            <div className="hub-nav-scroll" ref={navRef} onKeyDown={onNavKey}>
              {GROUPS.map((grp) => {
                const items = RAIL.filter((s) => s.group === grp.id);
                if (items.length === 0) return null;
                return (
                  <nav key={grp.id} className="hub-nav" role="tablist" aria-label={t(grp.label)}>
                    <span className="hub-nav-head">{t(grp.label)}</span>
                    {items.map((s) => {
                      const why = disabled?.[s.id];
                      const n = badges?.[s.id] ?? 0;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          role="tab"
                          data-section={s.id}
                          aria-selected={active === s.id}
                          // Roving tabindex: one stop for the whole rail,
                          // arrows move within it.
                          tabIndex={active === s.id ? 0 : -1}
                          className={`hub-tab${active === s.id ? " is-active" : ""}`}
                          disabled={!!why}
                          title={why || undefined}
                          onClick={() => onSelect(s.id)}
                        >
                          <span className="hub-tab-icon" aria-hidden><s.Icon size={15} /></span>
                          <span className="hub-tab-label">{t(s.label)}</span>
                          {/* Counts what is ACTIONABLE. A badge that also
                              counts things already dealt with is a badge
                              people learn to stop reading. */}
                          {n > 0 && (
                            <span className="hub-tab-badge" aria-label={`${n} ${t("waiting")}`}>
                              {n > 99 ? "99+" : n}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </nav>
                );
              })}
            </div>
          </aside>

          <div className="hub-main">
            {/* ONE header for every section, so a pane never has to build its
                own and no two of them can disagree about where a title sits.
                Sections contribute only the right-hand slot. */}
            <header className="hub-head">
              <div className="hub-head-text">
                <h2>{t(def.label)}</h2>
                {content.note && <p className="hub-head-note">{content.note}</p>}
              </div>
              {content.HeaderRight && (
                <div className="hub-head-right"><content.HeaderRight /></div>
              )}
              <button className="g-modal-close hub-close" onClick={onClose} aria-label={t("Close")}>×</button>
            </header>

            <div
              // key: remount on section change so a pane never inherits the
              // previous one's scroll position — landing halfway down
              // Settings because Social was scrolled is a small thing that
              // feels broken every single time.
              key={active}
              className={`hub-pane${content.fill ? " hub-pane--fill" : ""}`}
              role="tabpanel"
            >
              <content.Body />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The numbers on the rail.
 *
 * Read from the same stores the standalone surfaces already used — the
 * friend-request poll and the shared giveaway snapshot — rather than from
 * anything new. The rail is a VIEW of state the app already keeps; giving it
 * its own source would let it disagree with the section it points at, which
 * is exactly what teaches people to distrust badges.
 */
export function useHubBadges(): Partial<Record<HubSection, number>> {
  const { count: requests } = useIncomingRequestCount();
  const snap = useGiveaways();
  const st = railState({
    giveaways: snap.giveaways,
    stats: snap.stats,
    now: Date.now(),
    seenWins: seenWins(),
    error: snap.error,
    promos: snap.promos,
  });
  // What is worth a number in Rewards: a win to look at, a free reward not
  // collected, or a live giveaway not entered. Never "things that exist".
  const rewards =
    st.kind === "won" || st.kind === "promo" ? 1
    : st.unenteredCount > 0 ? st.unenteredCount
    : 0;
  return { social: requests, rewards };
}
