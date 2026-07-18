import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type ErrorEntry, type ErrorGroup } from "../api";

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
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // Grouped counts come from the server now. Tallying the fetched rows
  // client-side produced a FLOOR — capped by the row limit — which
  // understated a runaway error precisely when it mattered most.
  const [groups, setGroups] = useState<ErrorGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedFingerprint, setExpandedFingerprint] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setErr(null);
    const k = kind === "all" ? "" : kind;
    Promise.all([
      api.listErrors(k, 500),
      api.listErrorGroups(k, 14),
    ])
      .then(([rows, g]) => {
        setErrors(rows.errors);
        setTotal(rows.total);
        setTruncated(rows.truncated);
        setGroups(g.groups);
      })
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
        {/* The page asked for 500 rows and the server silently returned
            200, so this used to read "200 errors" whether there were 200
            or 20,000. Say what is actually being shown, and out of how
            many. */}
        <span className="dim small" style={{ marginLeft: "auto" }}>
          {truncated
            ? `Showing ${errors.length.toLocaleString()} of ${total.toLocaleString()} errors`
            : `${total.toLocaleString()} error${total === 1 ? "" : "s"}`}
        </span>
      </div>

      {err && <div className="page-err">{err}</div>}

      {truncated && view !== "grouped" && (
        <p className="dim small err-trunc-note">
          Newest {errors.length.toLocaleString()} shown. Counts in the
          {" "}
          <button className="linklike" onClick={() => setView("grouped")}>Grouped</button>
          {" "}
          view are computed server-side over all {total.toLocaleString()} rows.
        </p>
      )}

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
          groups={groups}
          rows={errors}
          busy={busy}
          expanded={expandedFingerprint}
          onToggle={(fp) => setExpandedFingerprint(expandedFingerprint === fp ? null : fp)}
          onResolve={async (g) => {
            if (!window.confirm(
              `Resolve this error group?\n\n${g.message.slice(0, 160)}\n\n`
              + `This permanently deletes all ${g.count.toLocaleString()} recorded `
              + `occurrence(s). Do this once the bug is actually FIXED — the history `
              + `is then just noise burying live errors.\n\nIt will reappear if the bug recurs.`
            )) return;
            setErr(null);
            try {
              await api.clearErrorGroup(g.kind, g.fingerprint);
              reload();
            } catch (e) {
              setErr(`Couldn't resolve: ${(e as Error).message}`);
            }
          }}
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
          <td colSpan={7}>
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

// ─── Grouped view — counts come from the SERVER ────────────────────
//
// This used to fingerprint and tally the rows the page had fetched.
// That made every count a floor bounded by the row cap: a bug with
// 3,000 occurrences reported as "200", and it broke worst exactly when
// one looping error was drowning the log — the case the grouped view
// exists to surface. Counts now come from a groupBy over the whole
// table (GET /errors/groups), so they are true regardless of what the
// row endpoint returns.
//
// The server groups by (kind, fingerprint) — message with variable
// data (ids, uuids, timestamps, digit runs) normalized to placeholders,
// so one real error type doesn't fragment into a separate group per
// occurrence just because it happened to embed a different id or
// version number each time. `message` on a group is a real sample for
// display only; joins/Resolve use `fingerprint`. The occurrence
// drill-down still uses the fetched rows, and says so, since those ARE
// capped.
function ErrorGrouped({
  groups, rows, busy, expanded, onToggle, onResolve,
}: {
  groups: ErrorGroup[];
  rows: ErrorEntry[];
  busy: boolean;
  expanded: string | null;
  onToggle: (fp: string) => void;
  onResolve: (g: ErrorGroup) => void;
}) {
  if (busy) return <p className="dim">Loading…</p>;
  if (groups.length === 0) return <p className="dim center">No errors recorded.</p>;
  return (
    <table className="users-table">
      <thead>
        <tr>
          <th>Count</th><th>Kind</th><th>Source</th><th>Message</th><th>Last seen</th><th></th><th></th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const key = `${g.kind}::${g.fingerprint}`;
          const local = rows.filter((r) => r.kind === g.kind && r.fingerprint === g.fingerprint);
          return (
            <Fragment key={key}>
              <tr onClick={() => onToggle(key)} style={{ cursor: "pointer" }}>
                <td><strong className="tabular">{g.count.toLocaleString()}</strong></td>
                <td>
                  <span className={`tag ${g.kind === "server" ? "kind-server" : "kind-client"}`}>
                    {g.kind}
                  </span>
                </td>
                <td className="dim small mono">{g.sample?.source ?? "—"}</td>
                <td className="err-msg">{g.message}</td>
                <td className="dim small">{g.latestAt ? new Date(g.latestAt).toLocaleString() : "—"}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn-ghost btn-tiny"
                    title="This bug is fixed — delete its history so it stops burying live errors"
                    onClick={() => onResolve(g)}
                  >Resolve</button>
                </td>
                <td className="dim small">{expanded === key ? "▴" : "▾"}</td>
              </tr>
              {expanded === key && (
                <tr className="err-detail-row">
                  <td colSpan={7}>
                    {g.sample && (
                      <ErrorDetail
                        entry={{
                          id: g.sample.id,
                          kind: g.kind,
                          level: g.sample.level,
                          message: g.message,
                          fingerprint: g.fingerprint,
                          stack: g.sample.stack,
                          source: g.sample.source,
                          userId: g.sample.userId,
                          username: g.sample.username,
                          userAgent: g.sample.userAgent,
                          meta: null,
                          createdAt: g.latestAt,
                        }}
                      />
                    )}
                    {local.length > 0 && (
                      <details className="err-occurrences">
                        <summary className="dim small">
                          Show {local.length} recent occurrence{local.length === 1 ? "" : "s"}
                          {g.count > local.length && ` (of ${g.count.toLocaleString()} total — list is capped)`}
                        </summary>
                        <table className="occurrence-table">
                          <thead><tr><th>When</th><th>User</th><th>UA</th></tr></thead>
                          <tbody>
                            {local.map((e) => (
                              <tr key={e.id}>
                                <td className="dim small">{new Date(e.createdAt).toLocaleString()}</td>
                                <td className="dim small">{e.username ? `@${e.username}` : "—"}</td>
                                <td className="dim small mono err-ua">{e.userAgent ?? "—"}</td>
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
          );
        })}
      </tbody>
    </table>
  );
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
