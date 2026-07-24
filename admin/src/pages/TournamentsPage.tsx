import { useEffect, useState } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type AdminTournament } from "../api";

// Tournament admin page — v1 capabilities:
//   - Create a tournament (name + optional level cap + format)
//   - List existing tournaments + delete
//   - Add / remove participants by username
//   - Start a one-off match between two registered participants
//     (server spawns a server-authoritative @pkmn/sim battle room
//     with format=tournament + the tournament's level cap)
//
// Bracket auto-pairing / seeding / round advancement is a follow-up.
// For v1 the admin manually triggers each match — the server's
// PvpMatch table records winners so a future bracket runner can
// read history to advance.
export function TournamentsPage() {
  const [tournaments, setTournaments] = useState<AdminTournament[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    setErr(null);
    api.listTournaments()
      .then((d) => setTournaments(d.tournaments))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(reload, []);

  const sel = tournaments.find((t) => t.id === selected) ?? null;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Tournaments</h1>
        <p className="dim">
          Create bracket-style PvP events with optional level caps. Participants' Pokémon
          are temporarily clamped to the cap during matches; their real saves are unchanged.
        </p>
      </header>

      <div className="users-toolbar">
        <button className="btn-primary" onClick={reload} disabled={busy}>Refresh</button>
        <CreateTournament onCreated={reload} />
      </div>

      {err && <div className="page-err">{err}</div>}

      <div className="tournaments-grid">
        <table className="users-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Format</th>
              <th>Lv cap</th>
              <th>Status</th>
              <th>Entries</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tournaments.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={selected === t.id ? "selected" : ""}
                style={{ cursor: "pointer" }}
              >
                <td><strong>{t.name}</strong></td>
                <td className="dim small">{t.format}</td>
                <td>{t.levelCap ?? <span className="dim">—</span>}</td>
                <td>
                  <span className={`tag tournament-status-${t.status}`}>{t.status}</span>
                </td>
                <td>{t.entries.length}</td>
                <td className="dim small">{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {tournaments.length === 0 && !busy && (
              <tr><td colSpan={6} className="dim center">No tournaments yet.</td></tr>
            )}
          </tbody>
        </table>

        {sel && <TournamentDetail tournament={sel} onChange={reload} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

// ─── Create form ─────────────────────────────────────────────────────
function CreateTournament({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [levelCap, setLevelCap] = useState<number | "">(50);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setErr("Name required."); return; }
    setBusy(true);
    setErr(null);
    try {
      await api.createTournament({
        name: name.trim(),
        levelCap: typeof levelCap === "number" ? levelCap : null,
      });
      setName("");
      setLevelCap(50);
      setOpen(false);
      onCreated();
    } catch (e: any) {
      setErr(e?.message ?? "Could not create.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button className="btn-secondary" onClick={() => setOpen(true)}>+ New tournament</button>;
  }
  return (
    <div className="tournament-create">
      <input
        className="search-input"
        placeholder="Tournament name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <label className="tournament-cap-input">
        Lv cap
        <input
          type="number"
          min={1}
          max={100}
          value={levelCap}
          onChange={(e) => {
            const v = e.target.value;
            setLevelCap(v === "" ? "" : Math.max(1, Math.min(100, parseInt(v, 10) || 1)));
          }}
        />
      </label>
      <button className="btn-primary btn-small" onClick={submit} disabled={busy}>Create</button>
      <button className="btn-ghost btn-small" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      {err && <span className="dim small" style={{ color: "#fca5a5" }}>{err}</span>}
    </div>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────
function TournamentDetail({
  tournament, onChange, onClose,
}: {
  tournament: AdminTournament;
  onChange: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingA, setPendingA] = useState<string | null>(null);
  const [pendingB, setPendingB] = useState<string | null>(null);

  const addEntry = async () => {
    const username = window.prompt("Username to register:");
    if (!username) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.addTournamentEntry(tournament.id, username.trim());
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not add entry.");
    } finally {
      setBusy(false);
    }
  };
  const removeEntry = async (entryId: string) => {
    if (!await confirm("Remove this participant?")) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.removeTournamentEntry(tournament.id, entryId);
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not remove.");
    } finally {
      setBusy(false);
    }
  };
  const startMatch = async () => {
    if (!pendingA || !pendingB || pendingA === pendingB) {
      setMsg("Pick two different participants.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.startTournamentMatch(tournament.id, pendingA, pendingB);
      setMsg(`Match started: ${res.battleId}`);
      setPendingA(null);
      setPendingB(null);
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Match failed to start.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!await confirm(`Delete tournament "${tournament.name}"? Cascades to entries.`)) return;
    setBusy(true);
    try {
      await api.deleteTournament(tournament.id);
      onChange();
      onClose();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not delete.");
    } finally {
      setBusy(false);
    }
  };
  const setStatus = async (status: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.patchTournament(tournament.id, { status });
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not update.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tournament-detail">
      <header className="tournament-detail-head">
        <div>
          <h2>{tournament.name}</h2>
          <div className="dim small">
            {tournament.format} · Lv cap {tournament.levelCap ?? "—"} · status <strong>{tournament.status}</strong>
          </div>
        </div>
        <button className="btn-ghost" onClick={onClose}>×</button>
      </header>

      <section className="profile-section">
        <h3>Status & lifecycle</h3>
        <div className="profile-actions">
          <button className="btn-secondary btn-small" onClick={() => setStatus("open")} disabled={busy}>Open</button>
          <button className="btn-secondary btn-small" onClick={() => setStatus("live")} disabled={busy}>Live</button>
          <button className="btn-secondary btn-small" onClick={() => setStatus("completed")} disabled={busy}>Completed</button>
          <button className="btn-secondary btn-small" onClick={() => setStatus("cancelled")} disabled={busy}>Cancelled</button>
          <span style={{ flex: 1 }} />
          <button className="btn-danger btn-small" onClick={remove} disabled={busy}>Delete tournament</button>
        </div>
      </section>

      <section className="profile-section">
        <h3>Participants <span className="dim small">({tournament.entries.length})</span></h3>
        <div className="profile-actions" style={{ marginBottom: 10 }}>
          <button className="btn-primary btn-small" onClick={addEntry} disabled={busy}>+ Add by username</button>
        </div>
        {tournament.entries.length === 0 ? (
          <p className="dim small">No participants yet.</p>
        ) : (
          <table className="users-table">
            <thead><tr><th>Username</th><th>Seed</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tournament.entries.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.username}</strong></td>
                  <td>{e.seed ?? <span className="dim">—</span>}</td>
                  <td>
                    {e.eliminated
                      ? <span className="tag banned">eliminated</span>
                      : <span className="tag admin">active</span>}
                  </td>
                  <td><button className="btn-ghost btn-tiny" onClick={() => removeEntry(e.id)} disabled={busy}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="profile-section">
        <h3>Run a match</h3>
        <p className="dim small" style={{ marginTop: 0 }}>
          Pick two registered participants. The server spawns a battle room with this
          tournament's level cap; both players see a battle:start event and play live.
          Both must be online with non-empty parties.
        </p>
        <div className="tournament-match-row">
          <select value={pendingA ?? ""} onChange={(e) => setPendingA(e.target.value || null)}>
            <option value="">Player A…</option>
            {tournament.entries.map((e) => (
              <option key={e.id} value={e.userId}>{e.username}</option>
            ))}
          </select>
          <span className="dim">vs</span>
          <select value={pendingB ?? ""} onChange={(e) => setPendingB(e.target.value || null)}>
            <option value="">Player B…</option>
            {tournament.entries.map((e) => (
              <option key={e.id} value={e.userId}>{e.username}</option>
            ))}
          </select>
          <button
            className="btn-primary btn-small"
            onClick={startMatch}
            disabled={busy || !pendingA || !pendingB || pendingA === pendingB}
          >
            Start match
          </button>
        </div>
      </section>

      <BracketSection tournament={tournament} onChange={onChange} />

      {msg && <p className="profile-msg dim small">{msg}</p>}
    </div>
  );
}

// ─── Bracket section ────────────────────────────────────────────────
// Three states:
//   1. open + ≥2 entries → "Generate bracket" button
//   2. live + bracket → render rounds + per-match controls
//   3. completed → render final-state bracket read-only with champion
function BracketSection({
  tournament, onChange,
}: {
  tournament: AdminTournament;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const bracket = tournament.bracket
    ? safeParseBracket(tournament.bracket)
    : null;

  const generate = async () => {
    if (!await confirm(`Generate bracket from ${tournament.entries.length} participants? Status flips to 'live'.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.generateBracket(tournament.id);
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not generate.");
    } finally {
      setBusy(false);
    }
  };
  const advance = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.advanceBracket(tournament.id);
      if (res.championId) setMsg(`🏆 Tournament complete — champion: ${res.championId}`);
      else setMsg("Bracket advanced.");
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not advance.");
    } finally {
      setBusy(false);
    }
  };
  const startMatch = async (matchId: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.startBracketMatch(tournament.id, matchId);
      setMsg(`Match started: ${res.battleId}`);
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not start match.");
    } finally {
      setBusy(false);
    }
  };

  if (tournament.status === "open") {
    return (
      <section className="profile-section">
        <h3>Bracket</h3>
        <p className="dim small" style={{ marginTop: 0 }}>
          {tournament.entries.length < 2
            ? "Need at least 2 participants to generate a bracket."
            : "Once you generate the bracket, no further entries can be added (without delete + re-create)."}
        </p>
        <button
          className="btn-primary btn-small"
          onClick={generate}
          disabled={busy || tournament.entries.length < 2}
        >
          Generate bracket
        </button>
        {msg && <p className="profile-msg dim small">{msg}</p>}
      </section>
    );
  }

  if (!bracket) {
    return (
      <section className="profile-section">
        <h3>Bracket</h3>
        <p className="dim small">No bracket data.</p>
      </section>
    );
  }

  return (
    <section className="profile-section">
      <header className="bracket-section-head">
        <h3>Bracket</h3>
        {tournament.status === "live" && (
          <div className="profile-actions">
            <button className="btn-secondary btn-small" onClick={advance} disabled={busy}>
              Advance bracket
            </button>
          </div>
        )}
      </header>
      <div className="bracket-grid">
        {bracket.rounds.map((round) => (
          <div className="bracket-round" key={round.index}>
            <header>Round {round.index + 1}</header>
            {round.matches.map((m) => (
              <BracketMatchCard
                key={m.id}
                match={m}
                tournamentStatus={tournament.status}
                busy={busy}
                onStart={() => startMatch(m.id)}
              />
            ))}
          </div>
        ))}
      </div>
      {msg && <p className="profile-msg dim small">{msg}</p>}
    </section>
  );
}

// ─── Bracket match card ─────────────────────────────────────────────
function BracketMatchCard({
  match, tournamentStatus, busy, onStart,
}: {
  match: BracketMatch;
  tournamentStatus: string;
  busy: boolean;
  onStart: () => void;
}) {
  const aLabel = slotLabel(match.a);
  const bLabel = slotLabel(match.b);
  const ready =
    match.a.kind === "player" && match.b.kind === "player"
    && !match.battleId && !match.winnerId
    && tournamentStatus === "live";
  const inProgress = !!match.battleId && !match.winnerId;
  const winnerLabel =
    match.winnerId
      ? (match.a.kind === "player" && match.a.userId === match.winnerId ? aLabel
       : match.b.kind === "player" && match.b.userId === match.winnerId ? bLabel
       : "(winner)")
      : null;

  return (
    <div className={`bracket-match ${match.winnerId ? "resolved" : ""} ${inProgress ? "in-progress" : ""}`}>
      <div className={`bracket-slot ${winnerLabel === aLabel ? "winner" : ""}`}>{aLabel}</div>
      <div className={`bracket-slot ${winnerLabel === bLabel ? "winner" : ""}`}>{bLabel}</div>
      {ready && (
        <button className="btn-primary btn-tiny bracket-start" onClick={onStart} disabled={busy}>
          Start match
        </button>
      )}
      {inProgress && <div className="bracket-status dim small">In progress</div>}
      {match.winnerId && winnerLabel && (
        <div className="bracket-status">→ {winnerLabel}</div>
      )}
    </div>
  );
}

// ─── Bracket types (mirror of server/src/lib/bracket.ts) ───────────
type BracketSlot =
  | { kind: "player"; userId: string; username: string }
  | { kind: "bye" }
  | { kind: "winnerOf"; matchId: string }
  | { kind: "tbd" };
interface BracketMatch {
  id: string;
  a: BracketSlot;
  b: BracketSlot;
  battleId?: string | null;
  winnerId?: string | null;
}
interface Bracket {
  rounds: { index: number; matches: BracketMatch[] }[];
}

function safeParseBracket(s: string): Bracket | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && Array.isArray(v.rounds)) return v as Bracket;
  } catch { /* */ }
  return null;
}

function slotLabel(s: BracketSlot): string {
  if (s.kind === "player") return s.username || s.userId;
  if (s.kind === "bye") return "(bye)";
  if (s.kind === "winnerOf") return "TBD";
  return "—";
}
