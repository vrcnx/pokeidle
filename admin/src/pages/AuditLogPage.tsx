import { useEffect, useMemo, useState } from "react";
import { api, type AuditEntry } from "../api";
import { navigateTo } from "../App";

// Audit log viewer. Shows every admin action that touched another user
// (or chat / map / tournament). Newest first. Filter by action prefix
// (e.g. "user.ban") and by admin username so we can answer "what did
// admin X do today?" or "show every ban".

function actionTone(action: string): "danger" | "warn" | "good" | "neutral" {
  if (action.startsWith("user.ban") || action === "user.delete" || action === "chat.clearAll") return "danger";
  if (action === "user.unban" || action === "user.demote") return "warn";
  if (action.startsWith("user.promote") || action === "user.send_password_reset") return "good";
  return "neutral";
}

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(100);
  const [action, setAction] = useState("");
  const [admin, setAdmin] = useState("");

  const load = () => {
    setBusy(true);
    api.listAudit(limit)
      .then((d) => { setEntries(d.entries); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [limit]);

  // Client-side filter so the UI is responsive even as we ramp the row
  // count up. The server endpoint isn't paginated yet.
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (action && !e.action.toLowerCase().includes(action.toLowerCase())) return false;
      if (admin && !e.admin.username.toLowerCase().includes(admin.toLowerCase())) return false;
      return true;
    });
  }, [entries, action, admin]);

  // Group by action for the side facet so we see "who's clicking what".
  const actionFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.action, (m.get(e.action) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [entries]);

  return (
    <div className="page audit-page">
      <header className="page-head">
        <h1>Audit log</h1>
        <p className="dim">Every admin action that touched another user, the map, chat, or a tournament. Newest first.</p>
      </header>

      {err && <div className="page-err">{err}</div>}

      <section className="chat-filter-bar">
        <input
          className="search-input"
          placeholder="Filter by action (e.g. user.ban)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <input
          className="search-input"
          placeholder="Filter by admin username"
          value={admin}
          onChange={(e) => setAdmin(e.target.value)}
          style={{ minWidth: 200 }}
        />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
        </select>
        <button className="btn-ghost btn-small" onClick={load} disabled={busy}>Refresh</button>
        <span className="dim small" style={{ marginLeft: "auto" }}>
          Showing {filtered.length} of {entries.length}
        </span>
      </section>

      <div className="chat-mod-grid">
        <section className="chat-mod-main" style={{ paddingTop: 4 }}>
          {filtered.length === 0 && !busy && (
            <div className="chat-empty">No matching entries.</div>
          )}
          <ul className="chat-mod-list">
            {filtered.map((e) => (
              <li key={e.id} className="audit-row">
                <div className="audit-row-head">
                  <span className={`tag audit-action audit-action--${actionTone(e.action)}`}>
                    {e.action}
                  </span>
                  <span className="dim small">
                    {new Date(e.createdAt).toLocaleString([], {
                      year: "numeric", month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="audit-row-actors">
                  <span><strong>@{e.admin.username}</strong></span>
                  {e.target && (
                    <>
                      <span className="dim">→</span>
                      {/* The server resolves targetId against the user
                          table and yields "?" when the row is gone — a
                          deleted account, or a non-user target like a
                          tournament id. Rendering "@?" told the operator
                          nothing; show the raw id (which is still a real
                          handle they can search) and only offer the
                          click-through when it resolves to a live user. */}
                      {e.target.username === "?" ? (
                        <span className="dim mono small" title={`Target ${e.target.id} is not a current user — deleted, or a non-user target such as a tournament.`}>
                          {e.target.id}
                        </span>
                      ) : (
                        <button
                          className="linklike"
                          onClick={() => navigateTo("users", { userId: e.target!.id })}
                          title={`Open ${e.target.username} in Users`}
                        >
                          <strong>@{e.target.username}</strong>
                        </button>
                      )}
                    </>
                  )}
                </div>
                {e.meta != null && (typeof e.meta === "object" ? Object.keys(e.meta as object).length > 0 : true) && (
                  <details className="audit-row-meta">
                    <summary className="dim small">Details</summary>
                    <pre className="audit-meta-pre">{JSON.stringify(e.meta, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
        <aside className="chat-mod-side">
          <section className="card chat-side-card">
            <h2>Top actions</h2>
            {actionFacets.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-channel-list">
                  {actionFacets.map(([a, n]) => (
                    <li
                      key={a}
                      className={`chat-channel-row ${action === a ? "selected" : ""}`}
                      onClick={() => setAction(a)}
                    >
                      <span className={`tag audit-action audit-action--${actionTone(a)}`}>{a}</span>
                      <span className="tabular dim">{n}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </section>
        </aside>
      </div>
    </div>
  );
}
