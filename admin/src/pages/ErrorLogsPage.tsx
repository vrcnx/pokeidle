import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type ErrorEntry } from "../api";

type Kind = "all" | "server" | "client";
type ViewMode = "table" | "grouped" | "raw";

// Server crashes + browser exceptions. Three view modes:
//   - table: row per error, expandable for stack/meta
//   - grouped: same errors collapsed by message-fingerprint with counts
//   - raw: plain-text dump for fast copy-paste into a chat / search
export function ErrorLogsPage() {
  const [kind, setKind] = useState<Kind>("all");
  const [view, setView] = useState<ViewMode>("table");
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedFingerprint, setExpandedFingerprint] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listErrors(kind === "all" ? "" : kind, 500)
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
          <option value="all">All sources</option>
          <option value="server">Server only</option>
          <option value="client">Client only</option>
        </select>
        <div className="seg-tabs" role="tablist" aria-label="View mode">
          {(["table", "grouped", "raw"] as ViewMode[]).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`seg-tab ${view === v ? "active" : ""}`}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
        <span className="dim small" style={{ marginLeft: "auto" }}>
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
      </div>

      {err && <div className="page-err">{err}</div>}

      {view === "table" && (
        <ErrorTable
          errors={errors}
          busy={busy}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
        />
      )}
      {view === "grouped" && (
        <ErrorGrouped
          errors={errors}
          busy={busy}
          expanded={expandedFingerprint}
          onToggle={(fp) => setExpandedFingerprint(expandedFingerprint === fp ? null : fp)}
        />
      )}
      {view === "raw" && (
        <ErrorRaw errors={errors} />
      )}
    </div>
  );
}

// ─── Table view (one row per error, click to expand stack) ────────────
function ErrorTable({
  errors, busy, expandedId, onToggle,
}: {
  errors: ErrorEntry[]; busy: boolean;
  expandedId: string | null; onToggle: (id: string) => void;
}) {
  return (
    <table className="users-table">
      <thead>
        <tr><th>When</th><th>Kind</th><th>Source</th><th>Message</th><th>User</th><th></th></tr>
      </thead>
      <tbody>
        {errors.map((e) => (
          <ErrorRow
            key={e.id}
            entry={e}
            expanded={expandedId === e.id}
            onToggle={() => onToggle(e.id)}
          />
        ))}
        {errors.length === 0 && !busy && (
          <tr><td colSpan={6} className="dim center">No errors recorded.</td></tr>
        )}
      </tbody>
    </table>
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
          <span className={`tag ${entry.kind === "server" ? "kind-server" : "kind-client"}`}>
            {entry.kind}
          </span>
        </td>
        <td className="dim small mono">{entry.source ?? "—"}</td>
        <td className="err-msg">{entry.message}</td>
        <td className="dim small">{entry.username ?? "—"}</td>
        <td className="dim small">{expanded ? "▴" : "▾"}</td>
      </tr>
      {expanded && (
        <tr className="err-detail-row">
          <td colSpan={6}>
            <ErrorDetail entry={entry} />
          </td>
        </tr>
      )}
    </>
  );
}

function ErrorDetail({ entry }: { entry: ErrorEntry }) {
  return (
    <div className="err-detail">
      {entry.stack && (
        <div>
          <strong className="err-detail-label">Stack</strong>
          <pre className="err-stack">{entry.stack}</pre>
        </div>
      )}
      {entry.userAgent && (
        <div>
          <strong className="err-detail-label">User agent</strong>
          <div className="mono small">{entry.userAgent}</div>
        </div>
      )}
      {entry.meta != null && (
        <div>
          <strong className="err-detail-label">Metadata</strong>
          <pre className="err-stack">{JSON.stringify(entry.meta, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

// ─── Grouped view (collapse same-fingerprint errors with counts) ──────
//
// Fingerprint = `${kind}:${source}:${first-line-of-stack-or-message}`. We
// don't trim numbers / paths / line numbers because two crashes at the
// same line in the same file are usually the same bug; the small risk
// is dynamic line numbers (e.g., from minified bundles) splitting one
// real bug into N groups, which is acceptable for an admin tool.
function ErrorGrouped({
  errors, busy, expanded, onToggle,
}: {
  errors: ErrorEntry[]; busy: boolean;
  expanded: string | null; onToggle: (fp: string) => void;
}) {
  const groups = useMemo(() => groupErrors(errors), [errors]);
  if (busy) return <p className="dim">Loading…</p>;
  if (groups.length === 0) return <p className="dim center">No errors recorded.</p>;
  return (
    <table className="users-table">
      <thead>
        <tr>
          <th>Count</th><th>Kind</th><th>Source</th><th>Sample message</th><th>Last seen</th><th></th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <Fragment key={g.fingerprint}>
            <tr
              onClick={() => onToggle(g.fingerprint)}
              style={{ cursor: "pointer" }}
            >
              <td><strong>{g.count}</strong></td>
              <td>
                <span className={`tag ${g.sample.kind === "server" ? "kind-server" : "kind-client"}`}>
                  {g.sample.kind}
                </span>
              </td>
              <td className="dim small mono">{g.sample.source ?? "—"}</td>
              <td className="err-msg">{g.sample.message}</td>
              <td className="dim small">{new Date(g.lastSeen).toLocaleString()}</td>
              <td className="dim small">{expanded === g.fingerprint ? "▴" : "▾"}</td>
            </tr>
            {expanded === g.fingerprint && (
              <tr className="err-detail-row">
                <td colSpan={6}>
                  <ErrorDetail entry={g.sample} />
                  {g.entries.length > 1 && (
                    <details className="err-occurrences">
                      <summary className="dim small">Show {g.entries.length} occurrences</summary>
                      <table className="occurrence-table">
                        <thead><tr><th>When</th><th>User</th><th>UA</th></tr></thead>
                        <tbody>
                          {g.entries.map((e) => (
                            <tr key={e.id}>
                              <td className="dim small">{new Date(e.createdAt).toLocaleString()}</td>
                              <td className="dim small">{e.username ?? "—"}</td>
                              <td className="dim small mono ua-cell" title={e.userAgent ?? ""}>{e.userAgent ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

interface ErrorGroup {
  fingerprint: string;
  count: number;
  lastSeen: string;
  sample: ErrorEntry;
  entries: ErrorEntry[];
}

function groupErrors(errors: ErrorEntry[]): ErrorGroup[] {
  const map = new Map<string, ErrorGroup>();
  for (const e of errors) {
    const fp = fingerprintError(e);
    const g = map.get(fp);
    if (g) {
      g.count += 1;
      g.entries.push(e);
      if (e.createdAt > g.lastSeen) g.lastSeen = e.createdAt;
    } else {
      map.set(fp, { fingerprint: fp, count: 1, lastSeen: e.createdAt, sample: e, entries: [e] });
    }
  }
  // Sort by count desc, then by recency.
  return Array.from(map.values()).sort((a, b) => b.count - a.count || (b.lastSeen.localeCompare(a.lastSeen)));
}

function fingerprintError(e: ErrorEntry): string {
  // Use the first non-empty line of the stack if available, otherwise
  // the message itself. Stack first-line tends to be more stable across
  // re-throws (the message can include user-supplied details).
  const stackHead = e.stack
    ? (e.stack.split("\n").map((s) => s.trim()).find(Boolean) ?? "")
    : "";
  const sig = stackHead || e.message;
  return `${e.kind}::${e.source ?? ""}::${sig}`;
}

// ─── Raw view (plain-text dump for copy-paste) ─────────────────────────
function ErrorRaw({ errors }: { errors: ErrorEntry[] }) {
  const text = useMemo(() => formatRaw(errors), [errors]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => window.alert(`Copied ${errors.length} error${errors.length === 1 ? "" : "s"} to clipboard.`),
      () => window.alert("Couldn't copy — clipboard write blocked."),
    );
  };
  return (
    <>
      <div className="raw-toolbar">
        <button className="btn-ghost btn-small" onClick={copy} disabled={errors.length === 0}>
          Copy all
        </button>
        <span className="dim small">{(text.length / 1024).toFixed(1)} KB</span>
      </div>
      <pre className="raw-save">{text || "No errors."}</pre>
    </>
  );
}

function formatRaw(errors: ErrorEntry[]): string {
  return errors.map((e) => {
    const head = `[${e.createdAt}] ${e.kind}/${e.level} ${e.source ?? "?"}`
      + (e.username ? ` (user: ${e.username})` : "");
    const body = e.message;
    const stack = e.stack ? `\n${e.stack}` : "";
    const meta = e.meta != null ? `\nmeta: ${JSON.stringify(e.meta)}` : "";
    return `${head}\n${body}${stack}${meta}\n`;
  }).join("\n────────────────────────────────────────\n");
}
