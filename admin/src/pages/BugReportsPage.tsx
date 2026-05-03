import { useEffect, useState } from "react";
import { api, type BugReport } from "../api";

const STATUS_OPTIONS = ["open", "investigating", "resolved", "wontfix"] as const;
type Status = (typeof STATUS_OPTIONS)[number];

export function BugReportsPage() {
  const [filter, setFilter] = useState<Status | "all">("open");
  const [reports, setReports] = useState<BugReport[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listBugReports(filter === "all" ? "" : filter, 100, 0)
      .then((d) => setReports(d.reports))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, [filter]);

  const updateStatus = async (id: string, status: Status) => {
    await api.updateBugReport(id, { status }).catch((e) => setErr(e.message));
    setReports((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
  };

  const saveNotes = async (id: string, adminNotes: string) => {
    await api.updateBugReport(id, { adminNotes }).catch((e) => setErr(e.message));
    setReports((rs) => rs.map((r) => (r.id === id ? { ...r, adminNotes } : r)));
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>Bug reports</h1>
        <p className="dim">Player-submitted issues with auto-attached game state.</p>
      </header>

      <div className="users-toolbar">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Status | "all")}
        >
          <option value="all">All</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
        <span className="dim small" style={{ marginLeft: 12 }}>
          {reports.length} report{reports.length === 1 ? "" : "s"}
        </span>
      </div>

      {err && <div className="page-err">{err}</div>}

      <table className="chat-table">
        <thead>
          <tr><th>When</th><th>Reporter</th><th>Title</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <RowGroup
              key={r.id}
              report={r}
              expanded={expandedId === r.id}
              onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
              onStatus={(s) => updateStatus(r.id, s)}
              onSaveNotes={(notes) => saveNotes(r.id, notes)}
            />
          ))}
          {reports.length === 0 && !busy && (
            <tr><td colSpan={5} className="dim center">No reports.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RowGroup({
  report, expanded, onToggle, onStatus, onSaveNotes,
}: {
  report: BugReport;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: Status) => void;
  onSaveNotes: (notes: string) => void;
}) {
  const [notesDraft, setNotesDraft] = useState(report.adminNotes ?? "");
  let parsedContext: any = null;
  try { parsedContext = report.context ? JSON.parse(report.context) : null; } catch { /* */ }
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td className="dim small">{new Date(report.createdAt).toLocaleString()}</td>
        <td><strong>{report.reporterName}</strong></td>
        <td>{report.title}</td>
        <td>
          <span className={`bug-status bug-status-${report.status}`}>{report.status}</span>
        </td>
        <td className="dim small">{expanded ? "▴" : "▾"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ background: "rgba(255,255,255,0.02)", padding: 16 }}>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Description</strong>
                <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0", fontFamily: "inherit", fontSize: 12 }}>
                  {report.description}
                </pre>
              </div>
              {report.page && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Page</strong>
                  <div className="g-mono small">{report.page}</div>
                </div>
              )}
              {report.userAgent && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>User agent</strong>
                  <div className="g-mono small">{report.userAgent}</div>
                </div>
              )}
              {parsedContext && (
                <div>
                  <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Game state</strong>
                  <pre style={{ fontSize: 11, background: "#0b0d12", padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 240 }}>
                    {JSON.stringify(parsedContext, null, 2)}
                  </pre>
                </div>
              )}
              <div>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Admin notes</strong>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={3}
                  style={{ width: "100%", fontFamily: "inherit", fontSize: 12 }}
                  placeholder="Internal notes — not visible to the reporter."
                />
                <button
                  className="btn-primary"
                  style={{ marginTop: 6 }}
                  onClick={() => onSaveNotes(notesDraft)}
                >Save notes</button>
              </div>
              <div>
                <strong style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Status</strong>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      className={s === report.status ? "btn-primary" : "btn-ghost"}
                      onClick={() => onStatus(s)}
                    >{s}</button>
                  ))}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
