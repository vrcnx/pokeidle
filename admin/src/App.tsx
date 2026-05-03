import { useEffect, useState } from "react";
import { api, ApiError, type AdminMe } from "./api";
import { UsersPage } from "./pages/UsersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { MapEditorPage } from "./pages/MapEditorPage";
import { ChatModerationPage } from "./pages/ChatModerationPage";

type Status = "loading" | "anon" | "forbidden" | "ok";
type Page = "analytics" | "users" | "map" | "chat";

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<AdminMe | null>(null);
  const [page, setPage] = useState<Page>("analytics");

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
  if (status === "anon") {
    return (
      <div className="admin-shell auth-prompt">
        <div className="auth-card">
          <h1>Pokémon Admin</h1>
          <p>You need to sign in as an admin to access this dashboard.</p>
          <p className="dim small">
            Sign in via the game first (
            <a href="http://localhost:5173" target="_blank" rel="noreferrer">localhost:5173</a>
            ) using the bootstrap admin email, then come back here.
          </p>
        </div>
      </div>
    );
  }
  if (status === "forbidden") {
    return (
      <div className="admin-shell auth-prompt">
        <div className="auth-card">
          <h1>Forbidden</h1>
          <p>Your account doesn't have admin privileges.</p>
        </div>
      </div>
    );
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
          <NavItem active={page === "analytics"} onClick={() => setPage("analytics")} label="Analytics" />
          <NavItem active={page === "users"} onClick={() => setPage("users")} label="Users" />
          <NavItem active={page === "map"} onClick={() => setPage("map")} label="Map editor" />
          <NavItem active={page === "chat"} onClick={() => setPage("chat")} label="Chat moderation" />
        </nav>
        <div className="admin-foot">
          <span className="admin-me">{me?.username}</span>
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
      </main>
    </div>
  );
}

function NavItem({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`admin-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}
