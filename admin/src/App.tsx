import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError, type AdminMe } from "./api";
import { UsersPage } from "./pages/UsersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { MapEditorPage } from "./pages/MapEditorPage";
import { ChatModerationPage } from "./pages/ChatModerationPage";
import { BugReportsPage } from "./pages/BugReportsPage";
import { ErrorLogsPage } from "./pages/ErrorLogsPage";
import { TournamentsPage } from "./pages/TournamentsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { LiveOpsPage } from "./pages/LiveOpsPage";
import { GiveawaysPage } from "./pages/GiveawaysPage";
import { MassGiftPage } from "./pages/MassGiftPage";
import { PollsPage } from "./pages/PollsPage";
import { BroadcastPage } from "./pages/BroadcastPage";
import { DiscordPage } from "./pages/DiscordPage";
import { ConfirmHost } from "./components/Confirm";
import { CommandPalette, type PaletteTarget } from "./components/CommandPalette";
import { useScrollbarWidthVar } from "./useScrollbarWidth";

type Status = "loading" | "anon" | "forbidden" | "ok" | "unreachable";
export type Page = "analytics" | "liveops" | "users" | "map" | "chat" | "bugs" | "errors" | "tournaments" | "giveaways" | "massgift" | "polls" | "audit" | "announcements" | "broadcast" | "discord";

// What a page can be asked to focus on when navigated to. The bus used
// to carry a page name and nothing else, which meant every cross-page
// action dead-ended: the operator could see a user misbehaving in chat,
// in the LiveOps feed, or in the audit log, and had no way to act on
// them without memorising the username, walking to Users, and typing it
// back in. Carrying a target turns "find the thing" into one click.
export interface NavParams {
  /** Open Users straight into this user's detail panel. */
  userId?: string;
  /** Pre-fill a page's search box (e.g. Users, Audit) with this. */
  query?: string;
}

const PAGES: Page[] = [
  "analytics", "liveops", "users", "map", "chat",
  "bugs", "errors", "tournaments", "giveaways", "massgift", "polls", "audit", "announcements", "broadcast", "discord",
];

// ── Hash routing ──────────────────────────────────────────────────────
// Navigation used to live entirely in useState, which meant: no deep
// links (you could not send a colleague "look at this user"), browser
// Back exited the whole dashboard to the previous site, and a refresh
// mid-investigation dumped you back on Analytics. That was the
// lowest-scoring dimension in the audit alongside destructive actions.
//
// A hash router rather than history/pushState on purpose: the admin app
// is a static SPA behind whatever host it lands on, and hash routes need
// zero server rewrite rules to survive a hard refresh on a deep link.
//
//   #/users
//   #/users?userId=abc123
//   #/audit?query=user.ban
function parseHash(): { page: Page; params: NavParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const page = (PAGES as string[]).includes(path) ? (path as Page) : "analytics";
  const sp = new URLSearchParams(qs ?? "");
  const params: NavParams = {};
  const userId = sp.get("userId");
  const query = sp.get("query");
  if (userId) params.userId = userId;
  if (query) params.query = query;
  return { page, params };
}

function buildHash(page: Page, params: NavParams): string {
  const sp = new URLSearchParams();
  if (params.userId) sp.set("userId", params.userId);
  if (params.query) sp.set("query", params.query);
  const qs = sp.toString();
  return `#/${page}${qs ? `?${qs}` : ""}`;
}

// Module-scoped navigation bus so any page can request a tab switch
// without prop-drilling through every component. It now writes the hash
// and lets the hashchange listener drive state, so programmatic
// navigation and manual URL edits go through exactly one code path —
// and every jump lands in browser history.
type NavRequest = { page: Page; params: NavParams };
const _navListeners = new Set<(r: NavRequest) => void>();
export function navigateTo(p: Page, params: NavParams = {}): void {
  const next = buildHash(p, params);
  if (window.location.hash !== next) {
    window.location.hash = next;   // hashchange → state update
  } else {
    // Same URL (e.g. re-clicking the current row): no hashchange event
    // will fire, so notify directly or the click would appear dead.
    for (const fn of _navListeners) fn({ page: p, params });
  }
}

// ── Navigation model ──────────────────────────────────────────────
// Fifteen destinations do not fit in a row, so they are grouped into six
// menus. The grouping is the one the sidebar used, so nothing anybody
// already knows has to be relearned — only the direction it opens in.
interface NavGroupDef {
  label: string;
  items: { page: Page; label: string; icon: ReactNode }[];
}

const NAV_GROUPS: NavGroupDef[] = [
  { label: "Overview", items: [
    { page: "analytics", label: "Analytics", icon: <IconChart /> },
    { page: "liveops",   label: "Live ops",  icon: <IconPulse /> },
  ] },
  { label: "People", items: [
    { page: "users", label: "Users", icon: <IconUsers /> },
  ] },
  { label: "Moderation", items: [
    { page: "chat",  label: "Chat",        icon: <IconChat /> },
    { page: "bugs",  label: "Bug reports", icon: <IconBug /> },
    { page: "audit", label: "Audit log",   icon: <IconHistory /> },
  ] },
  { label: "Events", items: [
    { page: "tournaments",   label: "Tournaments",   icon: <IconTrophy /> },
    { page: "giveaways",     label: "Giveaways",     icon: <IconGift /> },
    { page: "massgift",      label: "Mass gift",     icon: <IconGift /> },
    { page: "polls",         label: "Polls",         icon: <IconPoll /> },
    { page: "announcements", label: "Announcements", icon: <IconMegaphone /> },
  ] },
  { label: "Diagnostics", items: [
    { page: "errors", label: "Error log", icon: <IconAlert /> },
  ] },
  { label: "Tools", items: [
    { page: "discord",   label: "Discord",     icon: <IconChat /> },
    { page: "broadcast", label: "Broadcast",   icon: <IconBroadcast /> },
    { page: "map",       label: "Map editor",  icon: <IconMap /> },
  ] },
];

const PAGE_TITLES: Record<Page, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.page, i.label])),
) as Record<Page, string>;

// Derived, not hand-listed: a new destination added to NAV_GROUPS is
// searchable the moment it is navigable, with no second place to forget.
const PALETTE_TARGETS: PaletteTarget[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ page: i.page, label: i.label, group: g.label })),
);

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<AdminMe | null>(null);
  // Seed straight from the URL so a deep link or a refresh lands where
  // the operator actually was, not on Analytics.
  const [route, setRoute] = useState<{ page: Page; params: NavParams }>(parseHash);
  const page = route.page;
  const navParams = route.params;

  // The hash is the single source of truth. Browser Back/Forward and
  // manual URL edits both emit hashchange, and navigateTo writes the
  // hash rather than setting state, so all three paths converge here.
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    // Normalise a bare "/" or garbage path into a real route so the URL
    // always reflects what is on screen.
    if (!window.location.hash) {
      window.history.replaceState(null, "", buildHash(route.page, route.params));
    }
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Direct notifications from navigateTo for the same-URL case, where no
  // hashchange fires.
  useEffect(() => {
    const onNav = (r: NavRequest) => setRoute(r);
    _navListeners.add(onNav);
    return () => { _navListeners.delete(onNav); };
  }, []);

  // Clicking a sidebar item is a fresh intent, not a drill-down, so it
  // must clear any pending target — otherwise navigating Chat → Users
  // (focusing a player) and then clicking Users in the sidebar would
  // silently re-open that same player instead of the list.
  const gotoPage = (p: Page) => {
    navigateTo(p);
    // Close the drawer on navigate — leaving it open covers the page the
    // operator just asked for.
    setMobileNav(false);
  };

  const [mobileNav, setMobileNav] = useState(false);
  useScrollbarWidthVar();

  // Escape closes the drawer. Expected of any overlay, and the only
  // keyboard route out of it.
  useEffect(() => {
    if (!mobileNav) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNav]);

  const checkAuth = () => {
    setStatus("loading");
    api.me()
      .then((m) => { setMe(m); setStatus("ok"); })
      .catch((e: ApiError) => {
        // Only a real auth verdict may eject the operator. This used to
        // `else setStatus("anon")`, so ANY other failure — a network
        // blip, a 500, a timeout, the server restarting mid-deploy —
        // silently redirected them out of the dashboard to the game.
        // Losing your admin session because wifi hiccuped, while you
        // are mid-incident, is the worst possible time for it.
        if (e.status === 401) setStatus("anon");
        else if (e.status === 403) setStatus("forbidden");
        else setStatus("unreachable");
      });
  };
  useEffect(checkAuth, []);

  if (status === "loading") {
    return <div className="admin-shell"><p className="dim">Loading…</p></div>;
  }
  // The server said nothing useful — keep the operator here and let them
  // retry, rather than bouncing them to the game and making them sign in
  // again for what may have been a two-second blip.
  if (status === "unreachable") {
    return (
      <div className="admin-shell admin-shell--centered">
        <div className="admin-unreachable">
          <h2>Can’t reach the server</h2>
          <p className="dim">
            The admin API didn’t respond. This is usually a network blip or a
            deploy restarting — your session is probably still fine.
          </p>
          <button className="btn-primary" onClick={checkAuth}>Retry</button>
        </div>
      </div>
    );
  }
  // Anonymous (not signed in) and Forbidden (signed in but not admin)
  // share an outcome: bounce them to the live game. We countdown
  // visibly so it doesn't feel like a flash-redirect, and offer the
  // link as a manual fallback in case the auto-redirect is blocked
  // (popup blockers / iframe / etc.).
  if (status === "anon" || status === "forbidden") {
    return <NotAuthorized kind={status} />;
  }

  const PAGE_TITLES: Record<Page, string> = {
    analytics: "Analytics", liveops: "Live ops", users: "Users", map: "Map editor",
    chat: "Chat", bugs: "Bug reports", errors: "Error log", tournaments: "Tournaments",
    giveaways: "Giveaways", massgift: "Mass gift", polls: "Polls", audit: "Audit log",
    announcements: "Announcements", broadcast: "Broadcast", discord: "Discord",
  };
  // Production is anything not served from localhost. An operations console
  // should always answer "am I about to do this to real players?" without
  // being asked — this dashboard writes to live saves.
  const isProd = typeof window !== "undefined" && window.location.hostname !== "localhost";

  return (
    <div className="admin-shell">
      {mobileNav && (
        <button
          className="admin-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className="admin-sidebar" data-mobile-open={mobileNav ? "true" : "false"}>
        <div className="admin-brand">
          <img src="/logos/Pokeidle.svg" alt="Pokémon Idle" className="admin-brand-mark" />
          <span className="admin-brand-tag">Admin</span>
        </div>
        <nav className="admin-nav">
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Overview</span>
            <NavItem active={page === "analytics"} onClick={() => gotoPage("analytics")} label="Analytics" icon={<IconChart />} />
            <NavItem active={page === "liveops"} onClick={() => gotoPage("liveops")} label="Live ops" icon={<IconPulse />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">People</span>
            <NavItem active={page === "users"} onClick={() => gotoPage("users")} label="Users" icon={<IconUsers />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Moderation</span>
            <NavItem active={page === "chat"} onClick={() => gotoPage("chat")} label="Chat" icon={<IconChat />} />
            <NavItem active={page === "bugs"} onClick={() => gotoPage("bugs")} label="Bug reports" icon={<IconBug />} />
            <NavItem active={page === "audit"} onClick={() => gotoPage("audit")} label="Audit log" icon={<IconHistory />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Events</span>
            <NavItem active={page === "tournaments"} onClick={() => gotoPage("tournaments")} label="Tournaments" icon={<IconTrophy />} />
            <NavItem active={page === "giveaways"} onClick={() => gotoPage("giveaways")} label="Giveaways" icon={<IconGift />} />
            <NavItem active={page === "massgift"} onClick={() => gotoPage("massgift")} label="Mass gift" icon={<IconGift />} />
            <NavItem active={page === "polls"} onClick={() => gotoPage("polls")} label="Polls" icon={<IconPoll />} />
            <NavItem active={page === "announcements"} onClick={() => gotoPage("announcements")} label="Announcements" icon={<IconMegaphone />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Diagnostics</span>
            <NavItem active={page === "errors"} onClick={() => gotoPage("errors")} label="Error log" icon={<IconAlert />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Tools</span>
            <NavItem active={page === "discord"} onClick={() => gotoPage("discord")} label="Discord" icon={<IconChat />} />
            <NavItem active={page === "broadcast"} onClick={() => gotoPage("broadcast")} label="Broadcast" icon={<IconBroadcast />} />
            <NavItem active={page === "map"} onClick={() => gotoPage("map")} label="Map editor" icon={<IconMap />} />
          </div>
        </nav>
        <div className="admin-foot">
          <span className="admin-me" title={me?.username}>
            <span className="admin-avatar" aria-hidden>{(me?.username ?? "?").slice(0, 1)}</span>
            <span className="admin-me-name">{me?.username}</span>
          </span>
          <button className="admin-signout" onClick={() => api.signOut().then(() => location.reload())}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="admin-body">
        <header className="admin-topbar">
          {/* Mobile only — the desktop nav is always visible, so there is
              nothing here to toggle. Hidden by CSS rather than by condition,
              so the chrome does not reflow across the breakpoint. */}
          <button
            className="topbar-icon-btn topbar-burger"
            aria-label="Open navigation"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(true)}
          >
            <IconMenu />
          </button>
          <span className="topbar-crumb">{PAGE_TITLES[page] ?? "Admin"}</span>
          {/* Filled by <PageNote> / <PageActions> from whichever page is
              mounted. Pages used to render this themselves in a .page-head
              block, which repeated the title the bar already shows and cost
              ~100px before any content. */}
          <span id="topbar-page-note" className="topbar-note" />
          <span className="topbar-spacer" />
          <div id="topbar-page-actions" className="topbar-page-actions" />
          <div className="topbar-actions">
            <CommandPalette
              pages={PALETTE_TARGETS}
              onGoPage={(p) => gotoPage(p as Page)}
              onGoUser={(userId) => navigateTo("users", { userId })}
            />
            <span className={`topbar-env${isProd ? " is-prod" : ""}`}>
              {isProd ? "Production" : "Local"}
            </span>
          </div>
        </header>

        <main className="admin-main">
        {page === "analytics" && <AnalyticsPage />}
        {page === "users" && <UsersPage focusUserId={navParams.userId} initialQuery={navParams.query} />}
        {page === "map" && <MapEditorPage />}
        {page === "chat" && <ChatModerationPage />}
        {page === "bugs" && <BugReportsPage />}
        {page === "errors" && <ErrorLogsPage />}
        {page === "tournaments" && <TournamentsPage />}
        {page === "audit" && <AuditLogPage />}
        {page === "announcements" && <AnnouncementsPage />}
        {page === "liveops" && <LiveOpsPage />}
        {page === "giveaways" && <GiveawaysPage />}
        {page === "discord" && <DiscordPage />}
        {page === "massgift" && <MassGiftPage />}
        {page === "polls" && <PollsPage />}
        {page === "broadcast" && <BroadcastPage />}
        </main>
      </div>
      <ConfirmHost />
    </div>
  );
}

// Non-admin / non-signed-in users have no business here — bounce
// them straight to the live game. No countdown, no message, no
// flash of "Pokémon Admin" UI. Production points at pokeidle.com,
// dev falls back to the local game server, override via
// VITE_GAME_URL.
function NotAuthorized(_props: { kind: "anon" | "forbidden" }) {
  const gameUrl =
    (import.meta as any).env?.VITE_GAME_URL
    ?? (typeof window !== "undefined" && window.location.hostname !== "localhost"
      ? "https://pokeidle.com"
      : "http://localhost:5173");
  // window.location.replace fires synchronously, but doing it inside
  // an effect (rather than during render) keeps React happy and lets
  // the parent component finish its render cycle cleanly.
  useEffect(() => {
    window.location.replace(gameUrl);
  }, [gameUrl]);
  return null;
}

function NavItem({ active, label, onClick, icon }: { active: boolean; label: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button className={`admin-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className="admin-nav-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ── Inline SVG icons ────────────────────────────────────────────────
// Lucide-flavoured outline icons (16px). Inlining avoids pulling in
// an icon library for ~6 glyphs.
function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M7 14l3-3 3 3 5-5" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconChat() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconBug() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="6" width="8" height="14" rx="4" />
      <path d="M12 2v4M5 8l3 2M19 8l-3 2M3 14h3M21 14h-3M5 20l3-2M19 20l-3-2" />
    </svg>
  );
}
function IconAlert() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconMap() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function IconBroadcast() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M4.93 19.07a10 10 0 0 1 0-14.14M19.07 4.93a10 10 0 0 1 0 14.14M7.76 16.24a6 6 0 0 1 0-8.49M16.24 7.76a6 6 0 0 1 0 8.49" />
    </svg>
  );
}
function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function IconHistory() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}
function IconGift() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  );
}
function IconPoll() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}
function IconMegaphone() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-8v18l-18-8" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}
