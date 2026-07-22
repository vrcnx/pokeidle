import { useEffect, useState } from "react";
import { api, type AdminPoll } from "../api";

// Poll operations. Unlike a Giveaway (one-time entry, drawn once), a
// poll is live opinion data posted to Global chat — players vote
// directly on the chat card, results are public and update in real
// time, and a vote can change any time before the operator closes it.

const STATUS_FLOW: Record<string, string[]> = {
  draft:  ["open", "closed"],
  open:   ["closed"],
  closed: [],
};

export function PollsPage() {
  const [list, setList] = useState<AdminPoll[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = () => {
    api.listPollsAdmin()
      .then((d) => { setList(d.polls); setErr(null); })
      .catch((e) => setErr(e.message));
  };
  useEffect(load, []);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api.patchPoll(id, body); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const del = async (p: AdminPoll) => {
    if (!window.confirm(`Delete "${p.question}"?`)) return;
    setBusy(true); setErr(null);
    try { await api.deletePoll(p.id); load(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const rows = list ?? [];

  return (
    <div className="page polls-page">
      <header className="page-head">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
          <div>
            <h1>Polls</h1>
            <p className="dim">
              Posted to Global chat — players vote right on the card. Results are
              public and update live; a vote can change until you close it.
            </p>
          </div>
          <button className="btn-primary" onClick={() => setCreating(true)}>New poll</button>
        </div>
      </header>

      {err && <div className="page-err">{err}</div>}
      {creating && (
        <CreatePoll
          onCancel={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}

      {!list && <div className="page-loading">Loading…</div>}
      {list && rows.length === 0 && !creating && (
        <p className="dim">No polls yet. Create one to get started.</p>
      )}

      <div className="gv-list">
        {rows.map((p) => {
          const total = p.voteCount;
          return (
            <article key={p.id} className={`gv-card gv-card--${p.status}`}>
              <header className="gv-card-head">
                <div className="gv-card-title">
                  <strong>{p.question}</strong>
                  <span className={`tag gv-status gv-status--${p.status}`}>{p.status.toUpperCase()}</span>
                </div>
                <span className="dim small">
                  <strong className="tabular">{total}</strong> vote{total === 1 ? "" : "s"}
                </span>
              </header>

              <div className="poll-results">
                {p.options.map((opt, i) => {
                  const count = p.votes.filter((v) => v.optionIndex === i).length;
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  return (
                    <div key={i} className="poll-result-row">
                      <div className="poll-result-bar" style={{ width: `${pct}%` }} />
                      <span className="poll-result-label">{opt}</span>
                      <span className="poll-result-count dim small">{count} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>

              {p.voteCount > 0 && (
                <details className="gv-seed-details">
                  <summary className="dim small">Who voted what ({p.voteCount})</summary>
                  <ul className="poll-voter-list">
                    {p.votes.map((v) => (
                      <li key={v.userId}>
                        <span>@{v.username}</span>
                        <span className="dim small">{p.options[v.optionIndex] ?? "?"}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <footer className="gv-card-foot">
                {(STATUS_FLOW[p.status] ?? []).map((next) => (
                  <button
                    key={next}
                    className="btn-ghost btn-small"
                    disabled={busy}
                    onClick={() => patch(p.id, { status: next })}
                  >
                    {next === "open" ? "Open voting" : next === "closed" ? "Close voting" : next}
                  </button>
                ))}
                {p.status === "draft" && (
                  <button className="btn-danger btn-small" disabled={busy} onClick={() => del(p)}>
                    Delete
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ─── Create form ──────────────────────────────────────────────────────
function CreatePoll({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setOption = (i: number, v: string) => setOptions((prev) => prev.map((o, j) => (j === i ? v : o)));
  const addOption = () => setOptions((prev) => (prev.length < 10 ? [...prev, ""] : prev));
  const removeOption = (i: number) => setOptions((prev) => (prev.length > 2 ? prev.filter((_, j) => j !== i) : prev));

  const submit = async () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!q) { setErr("Give it a question."); return; }
    if (opts.length < 2) { setErr("Add at least 2 options."); return; }
    setBusy(true); setErr(null);
    try {
      await api.createPoll({ question: q, options: opts });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <section className="card gv-create">
      <h2>New poll</h2>
      {err && <div className="page-err">{err}</div>}

      <label className="gv-field">
        <span>Question</span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Which starter should get a balance pass next?"
          maxLength={280}
        />
      </label>

      <div className="gv-prize-builder">
        <h3>Options</h3>
        <ul className="gv-prize-list">
          {options.map((opt, i) => (
            <li key={i}>
              <input
                value={opt}
                onChange={(e) => setOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                maxLength={80}
                style={{ flex: 1, background: "transparent", border: "none", color: "inherit" }}
              />
              {options.length > 2 && (
                <button className="btn-ghost btn-tiny" onClick={() => removeOption(i)}>×</button>
              )}
            </li>
          ))}
        </ul>
        {options.length < 10 && (
          <button className="btn-secondary btn-small" onClick={addOption}>Add option</button>
        )}
      </div>

      <footer className="gv-create-foot">
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create as draft"}
        </button>
      </footer>
      <p className="dim small">
        Created as a draft — nobody sees it until you hit "Open voting".
      </p>
    </section>
  );
}
