import { useEffect, useState } from "react";
import { api, type ErrorEntry } from "../api";

type Kind = "all" | "server" | "client";

export function ErrorLogsPage() {
  const [kind, setKind] = useState<Kind>("all");
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listErrors(kind === "all" ? "" : kind, 200)
      .then((d) => setErrors(d.errors))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, [kind]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Error log</h1>
        <p className="dim">Server crashes + browser exceptions, newest first.</p>
      </header>

      <div className="users-toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="all">All</option>
          <option value="server">Server</option>
          <option value="client">Client</option>
        </select>
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
        <span className="dim small" style={{ marginLeft: 12 }}>
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
      </div>

      {err && <div className="page-err">{err}</div>}

      <table className="chat-table">
        <thead>
          <tr><th>When</th><th>Kind</th><th>Source</th><th>Message</th><th>User</th><th></th></tr>
        </thead>
        <tbody>
          {errors.map((e) => (
            <ErrorRow
              key={e.id}
              entry={e}
              expanded={expandedId === e.id}
              onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
            />
          ))}
          {errors.length === 0 && !busy && (
            <tr><td colSpan={6} className="dim center">No errors recorded.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ErrorRow({
  entry, expanded, onToggle,
}: {
  entry: ErrorEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td className="dim small">{new Date(entry.createdAt).toLocaleString()}</td>
        <td>
          <span className={`bug-status bug-status-${entry.kind === "server" ? "investigating" : "open"}`}>
            {entry.kind}
          </span>
        </td>
        <td className="dim small">{entry.source ?? "—"}</td>
        <td className="chat-content">{entry.message}</td>
        <td className="dim small">{entry.username ?? "—"}</td>
        <td className="dim small">{expanded ? "▴" : "▾"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ background: "rgba(255,255,255,0.02)", padding: 16 }}>
            <div style={{ display: "grid", gap: 12 }}>
              {entry.stack && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Stack</strong>
                  <pre style={{ fontSize: 11, background: "#0b0d12", padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 320 }}>
                    {entry.stack}
                  </pre>
                </div>
              )}
              {entry.userAgent && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>User agent</strong>
                  <div className="g-mono small">{entry.userAgent}</div>
                </div>
              )}
              {entry.meta != null && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Metadata</strong>
                  <pre style={{ fontSize: 11, background: "#0b0d12", padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 240 }}>
                    {JSON.stringify(entry.meta, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
