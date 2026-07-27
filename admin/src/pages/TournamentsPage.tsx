import { useEffect, useState } from "react";
import { confirm, notify } from "../components/Confirm";
import { api, type AdminTournament } from "../api";

// Tournament admin page.
//
// The event runs itself: once you generate the bracket,
// server/src/lib/tournamentRunner.ts starts each pairing the moment both
// players are online, feeds results back into the bracket, and decides
// any pairing whose round window expired. Everything on this page is
// either setup (create, participants, generate) or an override on top of
// the runner (Run now, Start match, Resolve by hand).
//
// The one number that matters for a real event is the ROUND WINDOW.
// ~34 accounts are online in a given hour and ~74 across a day, so a
// synchronous 16-player draw — which needs 16 specific people in the
// same 20 minutes — cannot happen. A window measured in hours makes the
// round asynchronous instead: play whenever you and your opponent are
// both on. See the runner's header for the full rationale.
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
              <th>Round</th>
              <th>Entries</th>
              <th>Champion</th>
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
                <td className="dim small">{formatWindow(t.roundWindowMinutes)}{t.autoRun ? "" : " (manual)"}</td>
                <td>{t.entries.length}</td>
                <td className="dim small">{t.championUsername ?? <span className="dim">—</span>}</td>
                <td className="dim small">{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {tournaments.length === 0 && !busy && (
              <tr><td colSpan={8} className="dim center">No tournaments yet.</td></tr>
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
  const [roundHours, setRoundHours] = useState<number | "">(24);
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
        roundWindowMinutes: (typeof roundHours === "number" ? roundHours : 24) * 60,
      });
      setName("");
      setLevelCap(50);
      setRoundHours(24);
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
      <label
        className="tournament-cap-input"
        title="How long each ROUND stays open. Players only need to be online at the same time as their own opponent, once, inside this window."
      >
        Round window (h)
        <input
          type="number"
          min={1}
          max={336}
          value={roundHours}
          onChange={(e) => {
            const v = e.target.value;
            setRoundHours(v === "" ? "" : Math.max(1, Math.min(336, parseInt(v, 10) || 1)));
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
        <h3>Status &amp; lifecycle</h3>
        <p className="dim small" style={{ marginTop: 0 }}>
          Round window <strong>{formatWindow(tournament.roundWindowMinutes)}</strong>
          {" \u00b7 "}
          {tournament.autoRun
            ? "the server runner starts pairings automatically and decides no-shows at the deadline."
            : "manual \u2014 the runner will not touch this event."}
          {tournament.championUsername && <> {"\u00b7"} champion <strong>{tournament.championUsername}</strong></>}
        </p>
        <div className="profile-actions">
          {/* Only legal forward transitions. The server rejects the rest
              with a 409; offering all four is how a live event got walked
              back to "open" and had its bracket regenerated. */}
          {(LEGAL_NEXT[tournament.status] ?? []).map((next) => (
            <button key={next} className="btn-secondary btn-small" onClick={() => setStatus(next)} disabled={busy}>
              {next === "cancelled" ? "Cancel event" : `to ${next}`}
            </button>
          ))}
          {(LEGAL_NEXT[tournament.status] ?? []).length === 0 && (
            <span className="dim small">{tournament.status} is terminal.</span>
          )}
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
            <thead><tr><th>Username</th><th>Seed</th><th>ELO at seed</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tournament.entries.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.username}</strong></td>
                  <td>{e.seed ?? <span className="dim">—</span>}</td>
                  <td className="dim small">{e.ratingAtSeed ?? <span className="dim">—</span>}</td>
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

// ─── Bracket section ──────────────────────────────────
// Three states:
//   1. open + >=2 entries -> "Generate bracket" button
//   2. live + bracket -> render rounds + per-match controls
//   3. completed -> render final-state bracket read-only with champion
//
// Under a running event most of these controls do nothing you have to
// do: the runner starts pairings on co-presence and settles the round at
// its deadline. They exist for when you want to force the issue.
function BracketSection({
  tournament, onChange,
}: {
  tournament: AdminTournament;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const bracket = tournament.bracket ? safeParseBracket(tournament.bracket) : null;

  const generate = async () => {
    const n = tournament.entries.length;
    const draw = nextPow2(n);
    if (!await confirm(
      `Generate bracket from ${n} participant${n === 1 ? "" : "s"}?\n\n`
      + `Draw size ${draw} (${draw - n} bye${draw - n === 1 ? "" : "s"}), `
      + `${Math.log2(draw)} round${Math.log2(draw) === 1 ? "" : "s"}, `
      + `${formatWindow(tournament.roundWindowMinutes)} per round.\n`
      + `Seeds are assigned from ELO. Status flips to 'live' and no further entries can be added.`,
    )) return;
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
  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.runTournament(tournament.id);
      setMsg(res.actions.length === 0
        ? "Nothing to do \u2014 waiting on players or on the round deadline."
        : res.actions.map((a) => `${a.kind}${a.matchId ? ` ${a.matchId}` : ""}${a.detail ? `: ${a.detail}` : ""}`).join(" | "));
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not run.");
    } finally {
      setBusy(false);
    }
  };
  const advance = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.advanceBracket(tournament.id);
      if (res.championId) setMsg(`Tournament complete \u2014 champion: ${res.tournament?.championUsername ?? res.championId}`);
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
  const resolve = async (matchId: string, winnerUserId: string, winnerLabel: string) => {
    if (!await confirm(`Award ${matchId} to ${winnerLabel} without playing it?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.resolveTournamentMatch(tournament.id, matchId, winnerUserId, "operator override");
      onChange();
    } catch (e: any) {
      setMsg(e?.message ?? "Could not resolve.");
    } finally {
      setBusy(false);
    }
  };

  if (tournament.status === "open") {
    const n = tournament.entries.length;
    const draw = nextPow2(n);
    return (
      <section className="profile-section">
        <h3>Bracket</h3>
        <p className="dim small" style={{ marginTop: 0 }}>
          {n < 2
            ? "Need at least 2 participants to generate a bracket."
            : `Draw sizes itself from sign-ups: ${n} entries \u2192 a ${draw}-slot bracket with `
              + `${draw - n} bye${draw - n === 1 ? "" : "s"} folded to the top seeds, `
              + `${Math.log2(draw)} round${Math.log2(draw) === 1 ? "" : "s"} of ${formatWindow(tournament.roundWindowMinutes)}. `
              + "Seeds come from ELO. Once generated, no further entries can be added (without delete + re-create)."}
        </p>
        <button
          className="btn-primary btn-small"
          onClick={generate}
          disabled={busy || n < 2}
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
            <button className="btn-primary btn-small" onClick={runNow} disabled={busy}>
              Run now
            </button>
            <button className="btn-secondary btn-small" onClick={advance} disabled={busy}>
              Advance bracket
            </button>
          </div>
        )}
      </header>
      {tournament.status === "live" && (
        <p className="dim small" style={{ marginTop: 0 }}>
          The runner sweeps every 15s: it starts a pairing as soon as both players are
          online, applies the result, and at the round deadline awards a walkover to
          whoever turned up (higher seed if neither did). "Run now" just does that
          immediately instead of on the next sweep.
        </p>
      )}
      <div className="bracket-grid">
        {bracket.rounds.map((round) => (
          <div className="bracket-round" key={round.index}>
            <header>{roundName(round.index, bracket.rounds.length)}</header>
            {round.matches.map((m) => (
              <BracketMatchCard
                key={m.id}
                match={m}
                tournamentStatus={tournament.status}
                busy={busy}
                onStart={() => startMatch(m.id)}
                onResolve={resolve}
              />
            ))}
          </div>
        ))}
      </div>
      {msg && <p className="profile-msg dim small">{msg}</p>}
    </section>
  );
}

// ─── Bracket match card ──────────────────────────────
function BracketMatchCard({
  match, tournamentStatus, busy, onStart, onResolve,
}: {
  match: BracketMatch;
  tournamentStatus: string;
  busy: boolean;
  onStart: () => void;
  onResolve: (matchId: string, winnerUserId: string, winnerLabel: string) => void;
}) {
  const aLabel = slotLabel(match.a);
  const bLabel = slotLabel(match.b);
  const bothPlayers = match.a.kind === "player" && match.b.kind === "player";
  const ready = bothPlayers && !match.battleId && !match.winnerId && tournamentStatus === "live";
  const inProgress = !!match.battleId && !match.winnerId;
  const winnerLabel =
    match.winnerId
      ? (match.a.kind === "player" && match.a.userId === match.winnerId ? aLabel
       : match.b.kind === "player" && match.b.userId === match.winnerId ? bLabel
       : "(winner)")
      : null;
  const overdue = !match.winnerId && match.deadlineAt != null && Date.now() > match.deadlineAt;

  return (
    <div className={`bracket-match ${match.winnerId ? "resolved" : ""} ${inProgress ? "in-progress" : ""}`}>
      <div className={`bracket-slot ${winnerLabel === aLabel ? "winner" : ""}`}>{aLabel}</div>
      <div className={`bracket-slot ${winnerLabel === bLabel ? "winner" : ""}`}>{bLabel}</div>
      {ready && (
        <div className="bracket-actions">
          <button className="btn-primary btn-tiny bracket-start" onClick={onStart} disabled={busy}>
            Start match
          </button>
          {match.a.kind === "player" && (
            <button
              className="btn-ghost btn-tiny"
              title="Award without playing"
              onClick={() => onResolve(match.id, (match.a as any).userId, aLabel)}
              disabled={busy}
            >
              {"\u2190"} award
            </button>
          )}
          {match.b.kind === "player" && (
            <button
              className="btn-ghost btn-tiny"
              title="Award without playing"
              onClick={() => onResolve(match.id, (match.b as any).userId, bLabel)}
              disabled={busy}
            >
              award {"\u2192"}
            </button>
          )}
        </div>
      )}
      {inProgress && <div className="bracket-status dim small">In progress</div>}
      {!match.winnerId && match.deadlineAt != null && (
        <div className={`bracket-status dim small ${overdue ? "overdue" : ""}`}>
          {overdue ? "deadline passed \u2014 next sweep decides it" : `due ${new Date(match.deadlineAt).toLocaleString()}`}
        </div>
      )}
      {match.winnerId && winnerLabel && (
        <div className="bracket-status">
          {"\u2192"} {winnerLabel}
          {match.winBy && match.winBy !== "battle" && <span className="dim small"> ({match.winBy})</span>}
        </div>
      )}
      {match.note && <div className="bracket-note dim small">{match.note}</div>}
    </div>
  );
}

// ─── Bracket types (mirror of server/src/lib/bracket.ts) ───────
type BracketSlot =
  | { kind: "player"; userId: string; username: string; seed?: number | null }
  | { kind: "bye" }
  | { kind: "winnerOf"; matchId: string }
  | { kind: "tbd" };
interface BracketMatch {
  id: string;
  a: BracketSlot;
  b: BracketSlot;
  battleId?: string | null;
  winnerId?: string | null;
  winBy?: "battle" | "bye" | "walkover" | "forfeit" | "admin" | null;
  deadlineAt?: number | null;
  attempts?: number;
  note?: string | null;
}
interface Bracket {
  rounds: { index: number; matches: BracketMatch[] }[];
}

/** Mirror of the server's status state machine (routes/admin.ts). Kept
 *  in sync by hand; the server is the authority and 409s anything else. */
const LEGAL_NEXT: Record<string, string[]> = {
  open: ["live", "cancelled"],
  live: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

function safeParseBracket(s: string): Bracket | null {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && Array.isArray(v.rounds)) return v as Bracket;
  } catch { /* */ }
  return null;
}

function slotLabel(s: BracketSlot): string {
  if (s.kind === "player") return s.seed ? `#${s.seed} ${s.username || s.userId}` : (s.username || s.userId);
  if (s.kind === "bye") return "(bye)";
  if (s.kind === "winnerOf") return "TBD";
  return "\u2014";
}

function roundName(index: number, total: number): string {
  const fromEnd = total - 1 - index;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-finals";
  if (fromEnd === 2) return "Quarter-finals";
  return `Round ${index + 1}`;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** "24h", "90m", "3d" \u2014 short enough for a table cell. */
function formatWindow(minutes: number): string {
  if (!Number.isFinite(minutes)) return "\u2014";
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
