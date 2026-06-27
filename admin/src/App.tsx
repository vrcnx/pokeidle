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

type Status = "loading" | "anon" | "forbidden" | "ok";
export type Page = "analytics" | "liveops" | "users" | "map" | "chat" | "bugs" | "errors" | "tournaments" | "audit" | "announcements";

// Module-scoped navigation bus so any page (e.g. an AnalyticsPage
// alert card) can request a tab switch without prop-drilling through
// every component. App subscribes once on mount and routes the
// request through the same setPage state setter.
const _navListeners = new Set<(p: Page) => void>();
export function navigateTo(p: Page): void {
  for (const fn of _navListeners) fn(p);
}

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<AdminMe | null>(null);
  const [page, setPage] = useState<Page>("analytics");

  // Wire the module-scoped nav helper to this App's setPage.
  useEffect(() => {
    _navListeners.add(setPage);
    return () => { _navListeners.delete(setPage); };
  }, []);

  useEffect(() => {
    api.me()
      .then((m) => { setMe(m); setStatus("ok"); })
      .catch((e: ApiError) => {
        if (e.status === 401) setStatus("anon");
        else if (e.status === 403) setStatus("forbidden");
        else setStatus("anon");
      });
  }, []);

  if (status === "loading") {
    return <div className="admin-shell"><p className="dim">Loading…</p></div>;
  }
  // Anonymous (not signed in) and Forbidden (signed in but not admin)
  // share an outcome: bounce them to the live game. We countdown
  // visibly so it doesn't feel like a flash-redirect, and offer the
  // link as a manual fallback in case the auto-redirect is blocked
  // (popup blockers / iframe / etc.).
  if (status === "anon" || status === "forbidden") {
    return <NotAuthorized kind={status} />;
  }

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <img src="/logos/pokeidle-icon.svg" alt="" className="admin-brand-icon" />
          <img src="/logos/Pokeidle.svg" alt="Pokémon Idle" className="admin-brand-mark" />
          <span className="admin-brand-tag">Admin</span>
        </div>
        <nav className="admin-nav">
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Overview</span>
            <NavItem active={page === "analytics"} onClick={() => setPage("analytics")} label="Analytics" icon={<IconChart />} />
            <NavItem active={page === "liveops"} onClick={() => setPage("liveops")} label="Live ops" icon={<IconPulse />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">People</span>
            <NavItem active={page === "users"} onClick={() => setPage("users")} label="Users" icon={<IconUsers />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Moderation</span>
            <NavItem active={page === "chat"} onClick={() => setPage("chat")} label="Chat" icon={<IconChat />} />
            <NavItem active={page === "bugs"} onClick={() => setPage("bugs")} label="Bug reports" icon={<IconBug />} />
            <NavItem active={page === "audit"} onClick={() => setPage("audit")} label="Audit log" icon={<IconHistory />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Events</span>
            <NavItem active={page === "tournaments"} onClick={() => setPage("tournaments")} label="Tournaments" icon={<IconTrophy />} />
            <NavItem active={page === "announcements"} onClick={() => setPage("announcements")} label="Announcements" icon={<IconMegaphone />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Diagnostics</span>
            <NavItem active={page === "errors"} onClick={() => setPage("errors")} label="Error log" icon={<IconAlert />} />
          </div>
          <div className="admin-nav-group">
            <span className="admin-nav-heading">Tools</span>
            <NavItem active={page === "map"} onClick={() => setPage("map")} label="Map editor" icon={<IconMap />} />
          </div>
        </nav>
        <div className="admin-foot">
          <span className="admin-me" title={me?.username}>{me?.username}</span>
          <button className="admin-signout" onClick={() => api.signOut().then(() => location.reload())}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="admin-main">
        {page === "analytics" && <AnalyticsPage />}
        {page === "users" && <UsersPage />}
        {page === "map" && <MapEditorPage />}
        {page === "chat" && <ChatModerationPage />}
        {page === "bugs" && <BugReportsPage />}
        {page === "errors" && <ErrorLogsPage />}
        {page === "tournaments" && <TournamentsPage />}
        {page === "audit" && <AuditLogPage />}
        {page === "announcements" && <AnnouncementsPage />}
        {page === "liveops" && <LiveOpsPage />}
      </main>
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
