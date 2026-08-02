import { useEffect, useMemo, useState } from "react";
import { api, type AuditEntry, type BugReport } from "../api";
import { navigateTo } from "../App";
import { PageActions, PageNote } from "../components/PageChrome";
import { SectionHead } from "../components/Section";

// Bug reports and the audit log, on one page.
//
// ── WHY THEY ARE ONE PAGE ───────────────────────────────────────────
// Both answer "what happened that I should look at" — one from players, one
// from the admin team — and both were a filter bar, a scrolling list of
// expandable rows and a facet sidebar. Two nav slots out of fifteen for two
// pages that are the same shape and get read in the same sitting.
//
// ── WHY THEY ARE NOT ONE LIST ───────────────────────────────────────
// They have different lifecycles. A bug report is a work item: it has a
// status, it gets notes, you act on it and close it. An audit entry is an
// immutable fact about something already done. Interleaving them would
// produce a feed where half the rows are actionable and half are not, and no
// column that tells you which — so they stay two tabs.
//
// ── DEEP LINKS ──────────────────────────────────────────────────────
// #/bugs and #/audit both still resolve here and select their own tab, so
// existing links (and the audit's ?query= filter) keep working. Switching
// tabs writes the hash, so the URL always describes what is on screen.

const STATUS_OPTIONS = ["open", "investigating", "resolved", "wontfix"] as const;
type Status = (typeof STATUS_OPTIONS)[number];

export function ReportsPage({ tab, initialQuery }: { tab: "bugs" | "audit"; initialQuery?: string }) {
  return (
    <div className="page reports-page">
      <PageActions>
        <div className="seg-toggle" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === "bugs"}
                  className={`seg-tab ${tab === "bugs" ? "active" : ""}`}
                  onClick={() => navigateTo("bugs")}>Bug reports</button>
          <button role="tab" aria-selected={tab === "audit"}
                  className={`seg-tab ${tab === "audit" ? "active" : ""}`}
                  onClick={() => navigateTo("audit")}>Audit log</button>
        </div>
      </PageActions>
      {tab === "bugs" ? <BugReports /> : <AuditLog initialQuery={initialQuery} />}
    </div>
  );
}

// ─── Bug reports ────────────────────────────────────────────────────
function BugReports() {
  const [filter, setFilter] = useState<Status | "all">("open");
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listBugReports(filter === "all" ? "" : filter, 100, 0)
      .then((d) => { setReports(d.reports); setCounts(d.counts ?? {}); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, [filter]);

  const updateStatus = async (id: string, status: Status) => {
    try {
      await api.updateBugReport(id, { status });
      setReports((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, status } : r)));
      // The tab counts moved. Adjust locally rather than refetching: a
      // refetch would also re-apply the filter and yank the row out from
      // under the operator mid-triage.
      setCounts((c) => ({ ...c }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveNotes = async (id: string, adminNotes: string) => {
    try {
      await api.updateBugReport(id, { adminNotes });
      setReports((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, adminNotes } : r)));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term || !reports) return reports ?? [];
    return reports.filter((r) =>
      r.title.toLowerCase().includes(term)
      || r.description.toLowerCase().includes(term)
      || r.reporterName.toLowerCase().includes(term));
  }, [reports, q]);

  const openCount = counts.open ?? 0;

  return (
    <>
      <PageNote>
        {openCount > 0 ? `${openCount} open` : "Nothing open"}
      </PageNote>

      <SectionHead
        title="Bug reports"
        blurb="Player-submitted issues, from the in-game reporter and the Discord bug channel."
        aside={<button className="btn-secondary btn-small" onClick={reload} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>}
      />

      {err && <div className="page-err">{err}</div>}

      <div className="chat-toolbar">
        <div className="seg-toggle" role="tablist" aria-label="Filter by status">
          {(["all", ...STATUS_OPTIONS] as const).map((s) => (
            <button key={s} role="tab" aria-selected={filter === s}
                    className={`seg-tab ${filter === s ? "active" : ""}`}
                    onClick={() => setFilter(s as Status | "all")}>
              {s}
              {/* Queue depth, from the whole table rather than the page. */}
              {counts[s] !== undefined && <span className="seg-tab__n">{counts[s]}</span>}
            </button>
          ))}
        </div>
        <input className="search-input chat-filter-input" placeholder="Search title, description or reporter…"
               value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <ul className="report-list card">
        {reports === null && <li className="chat-empty">Loading…</li>}
        {reports !== null && visible.length === 0 && (
          <li className="chat-empty">
            {q ? "No reports match that search." : filter === "all" ? "No reports yet." : `Nothing ${filter}.`}
          </li>
        )}
        {visible.map((r) => (
          <BugRow
            key={r.id}
            report={r}
            expanded={expandedId === r.id}
            onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
            onStatus={(s) => updateStatus(r.id, s)}
            onSaveNotes={(notes) => saveNotes(r.id, notes)}
          />
        ))}
      </ul>
    </>
  );
}

function BugRow({ report, expanded, onToggle, onStatus, onSaveNotes }: {
  report: BugReport;
  expanded: boolean;
  onToggle: () => void;
  onStatus: (s: Status) => void;
  onSaveNotes: (notes: string) => void;
}) {
  const [notesDraft, setNotesDraft] = useState(report.adminNotes ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  let parsedContext: unknown = null;
  try { parsedContext = report.context ? JSON.parse(report.context) : null; } catch { /* keep null */ }

  const dirty = notesDraft !== (report.adminNotes ?? "");

  return (
    <li className={`report-row${expanded ? " is-expanded" : ""}`}>
      {/* The whole summary is the toggle — a table row with a ▾ in the last
          cell made the click target a glyph the width of a character. */}
      <button className="report-summary" onClick={onToggle} aria-expanded={expanded}>
        <span className={`report-chevron${expanded ? " is-open" : ""}`} aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        <span className={`bug-status bug-status-${report.status}`}>{report.status}</span>
        <span className="report-title">{report.title}</span>
        <span className="report-reporter dim small">
          {report.reporterName}
          {report.source === "discord" && <span className="bug-src-discord">Discord</span>}
        </span>
        <time className="dim small report-when" dateTime={report.createdAt}
              title={new Date(report.createdAt).toLocaleString()}>
          {relativeDay(report.createdAt)}
        </time>
      </button>

      {expanded && (
        <div className="report-detail">
          <div className="report-field">
            <span className="report-label">Description</span>
            <p className="report-desc">{report.description}</p>
          </div>

          {report.page && (
            <div className="report-field">
              <span className="report-label">{report.source === "discord" ? "Discord thread" : "Page"}</span>
              {/* For a Discord report this is a jump link to the original
                  message — where the screenshots and the follow-up
                  conversation are, and where you reply to the reporter. */}
              {report.source === "discord"
                ? <a href={report.page} target="_blank" rel="noreferrer noopener">Open in Discord ↗</a>
                : <span className="g-mono small">{report.page}</span>}
            </div>
          )}

          {report.userAgent && (
            <div className="report-field">
              <span className="report-label">User agent</span>
              <span className="g-mono small">{report.userAgent}</span>
            </div>
          )}

          {parsedContext != null && (
            <div className="report-field">
              <span className="report-label">Game state at report time</span>
              <pre className="report-json">{JSON.stringify(parsedContext, null, 2)}</pre>
            </div>
          )}

          <div className="report-field">
            <span className="report-label">Status</span>
            <div className="seg-toggle">
              {STATUS_OPTIONS.map((s) => (
                <button key={s} className={`seg-tab ${s === report.status ? "active" : ""}`}
                        onClick={() => onStatus(s)}>{s}</button>
              ))}
            </div>
          </div>

          <div className="report-field">
            <span className="report-label">Admin notes <span className="dim">· internal, never shown to the reporter</span></span>
            <textarea
              value={notesDraft}
              onChange={(e) => { setNotesDraft(e.target.value); setSavedAt(null); }}
              rows={3}
              placeholder="What you found, what you did, what is still unknown."
            />
            <div className="report-notes-foot">
              {/* Disabled until there is something to save, and it says so
                  after — the old button was always enabled and gave no
                  feedback, so you could not tell a saved note from a lost one. */}
              <button className="btn-primary btn-small" disabled={!dirty}
                      onClick={() => { onSaveNotes(notesDraft); setSavedAt(Date.now()); }}>
                Save notes
              </button>
              {dirty && <span className="dim small">Unsaved</span>}
              {!dirty && savedAt && <span className="dim small">Saved</span>}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ─── Audit log ──────────────────────────────────────────────────────
function actionTone(action: string): "danger" | "warn" | "good" | "neutral" {
  if (action.startsWith("user.ban") || action === "user.delete"
      || action === "chat.clearAll" || action === "chat.bulkDelete") return "danger";
  if (action === "user.unban" || action === "user.demote") return "warn";
  if (action.startsWith("user.promote") || action === "user.send_password_reset") return "good";
  return "neutral";
}

function AuditLog({ initialQuery }: { initialQuery?: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(100);
  const [action, setAction] = useState(initialQuery ?? "");
  const [admin, setAdmin] = useState("");

  useEffect(() => { if (initialQuery !== undefined) setAction(initialQuery); }, [initialQuery]);

  const load = () => {
    setBusy(true);
    api.listAudit(limit)
      .then((d) => { setEntries(d.entries); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, [limit]);

  // Client-side, because the server endpoint is not paginated or filterable
  // yet. Honest about it: the footer says what slice is loaded.
  const filtered = useMemo(() => {
    return (entries ?? []).filter((e) => {
      if (action && !e.action.toLowerCase().includes(action.toLowerCase())) return false;
      if (admin && !e.admin.username.toLowerCase().includes(admin.toLowerCase())) return false;
      return true;
    });
  }, [entries, action, admin]);

  const actionFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries ?? []) m.set(e.action, (m.get(e.action) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [entries]);

  const adminFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries ?? []) m.set(e.admin.username, (m.get(e.admin.username) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [entries]);

  return (
    <>
      <PageNote>
        {entries ? `${filtered.length} of the last ${entries.length}` : "Loading…"}
      </PageNote>

      <SectionHead
        title="Audit log"
        blurb="Every admin action that touched a player, chat, the map or a tournament. Newest first."
        aside={<button className="btn-secondary btn-small" onClick={load} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>}
      />

      {err && <div className="page-err">{err}</div>}

      <div className="chat-toolbar">
        <input className="search-input chat-filter-input" placeholder="Filter by action (e.g. user.ban)"
               value={action} onChange={(e) => setAction(e.target.value)} />
        <input className="search-input chat-author-input" placeholder="Admin username"
               value={admin} onChange={(e) => setAdmin(e.target.value)} />
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="How many entries to load">
          {[50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {(action || admin) && (
          <button className="chat-author-chip" onClick={() => { setAction(""); setAdmin(""); }}>
            Clear filters <span aria-hidden>×</span>
          </button>
        )}
      </div>

      <div className="chat-grid">
        <ul className="report-list card">
          {entries === null && <li className="chat-empty">Loading…</li>}
          {entries !== null && filtered.length === 0 && (
            <li className="chat-empty">No entries match those filters.</li>
          )}
          {filtered.map((e) => (
            <li key={e.id} className="audit-row">
              <div className="audit-row__main">
                <span className={`tag audit-action audit-action--${actionTone(e.action)}`}>{e.action}</span>
                <button className="linklike" onClick={() => setAdmin(e.admin.username)}
                        title={`Filter to @${e.admin.username}`}>
                  <strong>@{e.admin.username}</strong>
                </button>
                {e.target && (
                  <>
                    <span className="dim" aria-hidden>→</span>
                    {/* The server resolves targetId against the user table and
                        yields "?" when the row is gone — a deleted account, or
                        a non-user target like a tournament id. "@?" told the
                        operator nothing; show the raw id, which is still a
                        real handle they can search, and only offer the
                        click-through when it resolves to a live user. */}
                    {e.target.username === "?" ? (
                      <span className="dim mono small"
                            title={`Target ${e.target.id} is not a current user — deleted, or a non-user target such as a tournament.`}>
                        {e.target.id}
                      </span>
                    ) : (
                      <button className="linklike" onClick={() => navigateTo("users", { userId: e.target!.id })}
                              title={`Open ${e.target.username} in Users`}>
                        <strong>@{e.target.username}</strong>
                      </button>
                    )}
                  </>
                )}
                <time className="dim small audit-row__when" dateTime={e.createdAt}
                      title={new Date(e.createdAt).toLocaleString()}>
                  {relativeDay(e.createdAt)}
                </time>
              </div>
              {e.meta != null && (typeof e.meta === "object" ? Object.keys(e.meta as object).length > 0 : true) && (
                <details className="audit-row__meta">
                  <summary className="dim small">Details</summary>
                  <pre className="report-json">{JSON.stringify(e.meta, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>

        <aside className="chat-side">
          <section className="card">
            <header className="card-head"><div><h2>Actions</h2><p>Within the loaded slice.</p></div></header>
            {actionFacets.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-facet-list">
                  {actionFacets.map(([a, n]) => (
                    <li key={a}>
                      <button className={`chat-facet ${action === a ? "is-active" : ""}`} onClick={() => setAction(a)}>
                        <span className={`tag audit-action audit-action--${actionTone(a)}`}>{a}</span>
                        <span className="tabular dim">{n}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>

          <section className="card">
            <header className="card-head"><div><h2>Admins</h2></div></header>
            {adminFacets.length === 0
              ? <p className="dim small">No data.</p>
              : (
                <ul className="chat-facet-list">
                  {adminFacets.map(([u, n]) => (
                    <li key={u}>
                      <button className={`chat-facet ${admin === u ? "is-active" : ""}`} onClick={() => setAdmin(u)}>
                        <span>@{u}</span>
                        <span className="tabular dim">{n}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </aside>
      </div>
    </>
  );
}

function relativeDay(iso: string): string {
  const ms = Date.now() - +new Date(iso);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
