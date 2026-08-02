import { useCallback, useEffect, useMemo, useState } from "react";
import { confirm } from "../components/Confirm";
import { api, type AdminTournament } from "../api";
import { navigateTo } from "../App";
import { Combobox } from "../components/Combobox";
import { PageActions, PageNote } from "../components/PageChrome";
import { Kpi, SectionHead } from "../components/Section";

// Tournament operations.
//
// ── HOW THE EVENT ACTUALLY RUNS ─────────────────────────────────────
// It runs itself. Once the bracket is generated,
// server/src/lib/tournamentRunner.ts sweeps every 15 seconds: it starts a
// pairing the moment both players are online, feeds the result back into the
// bracket, and at the round deadline awards a walkover to whoever turned up.
// Everything on this page is either setup or an override on top of that.
//
// The number that matters is the ROUND WINDOW. ~34 accounts are online in a
// given hour, so a synchronous 16-player draw — needing 16 specific people in
// the same 20 minutes — cannot happen. A window measured in hours makes the
// round asynchronous: play whenever you and your opponent are both on.
//
// ── WHAT WAS WRONG WITH THE OLD PAGE ────────────────────────────────
//   · The bracket — the whole point — was the LAST section, inside a detail
//     block, below a full-width table. Running an event meant scrolling past
//     everything else to see it, every time.
//   · Nothing said what needed attention. For a live event the only question
//     is "which matches are stuck?", and answering it meant reading every
//     card in every round.
//   · It never refreshed. The runner acts every 15s and the page sat still
//     until you pressed a button, so the state on screen was arbitrarily old
//     with nothing saying so.
//   · Adding a participant was a window.prompt with no autocomplete and no
//     validation until submit.
//
// Now: a narrow list rail, the bracket at full width beside it, a triage
// strip on live events, and polling while one is live.

export function TournamentsPage() {
  const [tournaments, setTournaments] = useState<AdminTournament[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const reload = useCallback((silent = false) => {
    api.listTournaments()
      .then((d) => {
        setTournaments(d.tournaments);
        setLastOk(Date.now());
        setErr(null);
        // Land on something rather than an empty right-hand pane: the live
        // event if there is one, else the newest.
        setSelected((cur) => {
          if (cur && d.tournaments.some((t) => t.id === cur)) return cur;
          return (d.tournaments.find((t) => t.status === "live")
            ?? d.tournaments.find((t) => t.status === "open")
            ?? d.tournaments[0])?.id ?? null;
        });
      })
      .catch((e) => { if (!silent) setErr(e.message); });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const sel = tournaments?.find((t) => t.id === selected) ?? null;
  const anyLive = !!tournaments?.some((t) => t.status === "live");

  // Poll only while something is live. A tournament in draft does not change
  // on its own, and a page that refetches every 15 seconds forever is a page
  // that fights you while you are typing into it.
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => reload(true), 15_000);
    return () => clearInterval(t);
  }, [anyLive, reload]);

  // Ticks the "updated Ns ago" label. Only mounted while polling is.
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  const rows = tournaments ?? [];

  return (
    <div className="page tournaments-page">
      <PageNote>
        {tournaments === null ? "Loading…"
          : anyLive ? `${rows.filter((t) => t.status === "live").length} live`
          : `${rows.length} event${rows.length === 1 ? "" : "s"}`}
      </PageNote>
      <PageActions>
        {anyLive && lastOk && (
          <span className="liveops-status is-live" title="The runner sweeps every 15s; so does this page.">
            <span className="liveops-status-dot" />
            {Math.round((Date.now() - lastOk) / 1000)}s
          </span>
        )}
        <button className="btn-secondary btn-small" onClick={() => reload()}>Refresh</button>
        <button className="btn-primary btn-small" onClick={() => setCreating(true)}>New tournament</button>
      </PageActions>

      {err && <div className="page-err">{err}</div>}

      {creating && (
        <CreateTournament
          onCancel={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); setSelected(id); reload(); }}
        />
      )}

      <div className="tour-layout">
        {/* ── Rail ────────────────────────────────────────────────
            Narrow on purpose. It is an index, and the bracket beside it
            needs every pixel it can get. */}
        <aside className="tour-rail card">
          {tournaments === null && <p className="dim small tour-empty">Loading…</p>}
          {tournaments !== null && rows.length === 0 && (
            <p className="dim small tour-empty">No tournaments yet.</p>
          )}
          {rows.map((t) => (
            <button
              key={t.id}
              className={`tour-rail-item${selected === t.id ? " is-active" : ""}`}
              onClick={() => setSelected(t.id)}
            >
              <span className="tour-rail-item__top">
                <span className="tour-rail-item__name">{t.name}</span>
                <span className={`tag tournament-status-${t.status}`}>{t.status}</span>
              </span>
              <span className="tour-rail-item__meta dim small">
                {t.entries.length} {t.entries.length === 1 ? "entry" : "entries"}
                {t.levelCap != null && <> · Lv{t.levelCap}</>}
                <> · {formatWindow(t.roundWindowMinutes)}/round</>
                {t.championUsername && <> · 🏆 {t.championUsername}</>}
              </span>
            </button>
          ))}
        </aside>

        <div className="tour-detail">
          {!sel && tournaments !== null && rows.length > 0 && (
            <p className="dim">Pick a tournament.</p>
          )}
          {sel && <TournamentDetail key={sel.id} tournament={sel} onChange={() => reload(true)} />}
        </div>
      </div>
    </div>
  );
}

// ─── Create ──────────────────────────────────────────────────────────
function CreateTournament({ onCancel, onCreated }: {
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
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
      const res = await api.createTournament({
        name: name.trim(),
        levelCap: typeof levelCap === "number" ? levelCap : null,
        roundWindowMinutes: (typeof roundHours === "number" ? roundHours : 24) * 60,
      });
      // Select the thing that was just created, rather than dropping the
      // operator back on whatever was selected before.
      onCreated(res.tournament.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card tour-create">
      <header className="card-head">
        <div>
          <h2>New tournament</h2>
          <p>Bracket-style PvP. Participants' Pokémon are clamped to the level cap during matches; their real saves are untouched.</p>
        </div>
      </header>
      <div className="tour-create__grid">
        <label className="gv-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
                 placeholder="e.g. Launch Week Cup" />
        </label>
        <label className="gv-field">
          <span>Level cap <em className="dim">blank = uncapped</em></span>
          <input type="number" min={1} max={100} value={levelCap}
                 onChange={(e) => setLevelCap(e.target.value === "" ? "" : clamp(parseInt(e.target.value, 10) || 1, 1, 100))} />
        </label>
        <label className="gv-field">
          {/* The one setting that decides whether the event is possible at
              all — so it gets the explanation, not a tooltip. */}
          <span>Round window (hours)</span>
          <input type="number" min={1} max={336} value={roundHours}
                 onChange={(e) => setRoundHours(e.target.value === "" ? "" : clamp(parseInt(e.target.value, 10) || 1, 1, 336))} />
        </label>
      </div>
      <p className="dim small">
        Each round stays open this long. Two players only need to be online at the
        same time as <em>each other</em>, once, inside the window — with ~34 accounts
        on in a given hour, anything under a few hours makes a 16-player draw
        impossible to finish.
      </p>
      {err && <div className="page-err">{err}</div>}
      <div className="profile-actions">
        <button className="btn-primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </section>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────
function TournamentDetail({ tournament, onChange }: {
  tournament: AdminTournament;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const out = await fn();
      if (out) setMsg(out);
      onChange();
    } catch (e) {
      setErr(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const bracket = tournament.bracket ? safeParseBracket(tournament.bracket) : null;

  // ── Triage ────────────────────────────────────────────────────────
  // The only question a live event actually asks. It used to require
  // reading every card in every round.
  const triage = useMemo(() => {
    if (!bracket) return null;
    const all = bracket.rounds.flatMap((r) => r.matches);
    const open = all.filter((m) => !m.winnerId);
    const playable = open.filter((m) => m.a.kind === "player" && m.b.kind === "player");
    return {
      total: all.length,
      done: all.length - open.length,
      inProgress: open.filter((m) => m.battleId).length,
      ready: playable.filter((m) => !m.battleId).length,
      overdue: open.filter((m) => m.deadlineAt != null && Date.now() > m.deadlineAt).length,
      waiting: open.length - playable.length,
    };
  }, [bracket]);

  const setStatus = (status: string) =>
    run("Status change", () => api.patchTournament(tournament.id, { status }).then(() => undefined));

  const remove = async () => {
    if (!await confirm(`Delete "${tournament.name}"? This cascades to its entries and bracket.`)) return;
    await run("Delete", () => api.deleteTournament(tournament.id).then(() => undefined));
  };

  return (
    <>
      <SectionHead
        title={tournament.name}
        blurb={
          `${tournament.format} · ${tournament.levelCap != null ? `Lv ${tournament.levelCap} cap` : "no level cap"}`
          + ` · ${formatWindow(tournament.roundWindowMinutes)} per round`
          + (tournament.autoRun ? " · runner enabled" : " · MANUAL — the runner will not touch this event")
        }
        aside={
          <>
            {/* Only legal forward transitions. Offering all four is how a
                live event got walked back to "open" and had its bracket
                regenerated; the server 409s the rest anyway. */}
            {(LEGAL_NEXT[tournament.status] ?? []).map((next) => (
              <button key={next}
                      className={next === "cancelled" ? "btn-ghost btn-small" : "btn-secondary btn-small"}
                      onClick={() => setStatus(next)} disabled={busy}>
                {next === "cancelled" ? "Cancel event" : `Move to ${next}`}
              </button>
            ))}
            <button className="btn-ghost btn-small tour-delete" onClick={remove} disabled={busy}>Delete</button>
          </>
        }
      />

      {err && <div className="page-err">{err}</div>}
      {msg && <div className="page-ok" role="status">{msg}</div>}

      {tournament.championUsername && (
        <div className="tour-champion">
          🏆 <strong>{tournament.championUsername}</strong> won this tournament.
        </div>
      )}

      {/* ── Live triage ─────────────────────────────────────────── */}
      {tournament.status === "live" && triage && (
        <>
          <section className="kpi-strip tour-triage">
            <Kpi label="Overdue" value={String(triage.overdue)}
                 state={triage.overdue > 0 ? "danger" : undefined}
                 hint="Past the round deadline. The next sweep awards a walkover to whoever turned up — higher seed if neither did." />
            <Kpi label="Ready" value={String(triage.ready)}
                 hint="Both players known and no battle yet. The runner starts these the moment both are online." />
            <Kpi label="In progress" value={String(triage.inProgress)} />
            <Kpi label="Waiting on earlier rounds" value={String(triage.waiting)} />
            <Kpi label="Decided" value={`${triage.done}/${triage.total}`} accent />
          </section>

          <div className="tour-runner">
            <span className="dim small">
              The runner sweeps every 15 seconds: starts a pairing as soon as both
              players are online, applies the result, and settles the round at its
              deadline. These force it now instead of on the next sweep.
            </span>
            <div className="profile-actions">
              <button className="btn-secondary btn-small" disabled={busy}
                      onClick={() => run("Run", async () => {
                        const res = await api.runTournament(tournament.id);
                        return res.actions.length === 0
                          ? "Nothing to do — waiting on players or on the round deadline."
                          : res.actions.map((a) => `${a.kind}${a.matchId ? ` ${a.matchId}` : ""}${a.detail ? `: ${a.detail}` : ""}`).join(" · ");
                      })}>
                Run now
              </button>
              <button className="btn-secondary btn-small" disabled={busy}
                      onClick={() => run("Advance", async () => {
                        const res = await api.advanceBracket(tournament.id);
                        return res.championId
                          ? `Complete — champion: ${res.tournament?.championUsername ?? res.championId}`
                          : "Bracket advanced.";
                      })}>
                Advance bracket
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Bracket ─────────────────────────────────────────────── */}
      {tournament.status === "open"
        ? <GenerateBracket tournament={tournament} busy={busy} run={run} />
        : bracket
          ? <BracketBoard
              bracket={bracket}
              status={tournament.status}
              busy={busy}
              onStart={(matchId) => run("Start match", async () => {
                const res = await api.startBracketMatch(tournament.id, matchId);
                return `Match started: ${res.battleId}`;
              })}
              onResolve={async (matchId, winnerUserId, winnerLabel) => {
                if (!await confirm(`Award ${matchId} to ${winnerLabel} without playing it?`)) return;
                await run("Resolve", () =>
                  api.resolveTournamentMatch(tournament.id, matchId, winnerUserId, "operator override").then(() => undefined));
              }}
            />
          : <p className="dim">No bracket data.</p>}

      <Participants tournament={tournament} busy={busy} run={run} />

      {/* An override that overlaps the bracket, so it is collapsed. Under a
          running event you never need it; when you do, you really do. */}
      <details className="tour-adhoc">
        <summary className="dim small">Start an ad-hoc match between two participants</summary>
        <AdHocMatch tournament={tournament} busy={busy} run={run} />
      </details>
    </>
  );
}

// ─── Generate ────────────────────────────────────────────────────────
function GenerateBracket({ tournament, busy, run }: {
  tournament: AdminTournament;
  busy: boolean;
  run: (label: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const n = tournament.entries.length;
  const draw = nextPow2(n);
  const rounds = draw > 1 ? Math.log2(draw) : 0;

  return (
    <section className="card tour-generate">
      <header className="card-head">
        <div>
          <h2>Bracket</h2>
          <p>Not generated yet — this event is still taking entries.</p>
        </div>
      </header>
      {n < 2 ? (
        <p className="dim small">Need at least 2 participants.</p>
      ) : (
        <>
          {/* The shape of the draw, before committing to it. Generating is
              one-way: status flips to live and no further entries can be
              added without deleting and re-creating the event. */}
          <div className="tour-draw-preview">
            <span><strong className="tabular">{n}</strong> entries</span>
            <span className="dim">→</span>
            <span><strong className="tabular">{draw}</strong>-slot draw</span>
            <span className="dim">·</span>
            <span><strong className="tabular">{draw - n}</strong> bye{draw - n === 1 ? "" : "s"} to the top seeds</span>
            <span className="dim">·</span>
            <span><strong className="tabular">{rounds}</strong> round{rounds === 1 ? "" : "s"} of {formatWindow(tournament.roundWindowMinutes)}</span>
          </div>
          <p className="dim small">
            Seeds come from ELO. Once generated the event goes live and the entry
            list is frozen.
          </p>
        </>
      )}
      <div className="profile-actions">
        <button className="btn-primary" disabled={busy || n < 2}
                onClick={() => run("Generate", async () => {
                  if (!await confirm(
                    `Generate the bracket from ${n} participant${n === 1 ? "" : "s"}?\n\n`
                    + `Draw size ${draw} (${draw - n} bye${draw - n === 1 ? "" : "s"}), ${rounds} round${rounds === 1 ? "" : "s"}, `
                    + `${formatWindow(tournament.roundWindowMinutes)} each.\n\n`
                    + `Status flips to 'live' and no further entries can be added.`)) return;
                  await api.generateBracket(tournament.id);
                })}>
          Generate bracket
        </button>
      </div>
    </section>
  );
}

// ─── Bracket board ───────────────────────────────────────────────────
function BracketBoard({ bracket, status, busy, onStart, onResolve }: {
  bracket: Bracket;
  status: string;
  busy: boolean;
  onStart: (matchId: string) => void;
  onResolve: (matchId: string, winnerUserId: string, winnerLabel: string) => void;
}) {
  return (
    <section className="card tour-bracket-card">
      <header className="card-head">
        <div>
          <h2>Bracket</h2>
          <p>{bracket.rounds.length} round{bracket.rounds.length === 1 ? "" : "s"}. Scroll sideways for later rounds.</p>
        </div>
      </header>
      {/* Its own horizontal scroller. A deep bracket is wider than any
          screen, and letting it push the page wide breaks every other
          page's alignment the moment you visit this one. */}
      <div className="tour-bracket">
        {bracket.rounds.map((round) => (
          <div className="tour-round" key={round.index}>
            <header className="tour-round__head">
              {roundName(round.index, bracket.rounds.length)}
              <span className="dim small">
                {round.matches.filter((m) => m.winnerId).length}/{round.matches.length}
              </span>
            </header>
            {round.matches.map((m) => (
              <MatchCard key={m.id} match={m} status={status} busy={busy}
                         onStart={() => onStart(m.id)} onResolve={onResolve} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function MatchCard({ match, status, busy, onStart, onResolve }: {
  match: BracketMatch;
  status: string;
  busy: boolean;
  onStart: () => void;
  onResolve: (matchId: string, winnerUserId: string, winnerLabel: string) => void;
}) {
  const bothPlayers = match.a.kind === "player" && match.b.kind === "player";
  const ready = bothPlayers && !match.battleId && !match.winnerId && status === "live";
  const inProgress = !!match.battleId && !match.winnerId;
  const overdue = !match.winnerId && match.deadlineAt != null && Date.now() > match.deadlineAt;
  const winnerOf = (s: BracketSlot) => s.kind === "player" && s.userId === match.winnerId;

  const state = match.winnerId ? "done" : inProgress ? "live" : overdue ? "overdue" : ready ? "ready" : "waiting";

  return (
    <div className={`tour-match is-${state}`}>
      <Slot slot={match.a} won={winnerOf(match.a)} lost={!!match.winnerId && !winnerOf(match.a)} />
      <Slot slot={match.b} won={winnerOf(match.b)} lost={!!match.winnerId && !winnerOf(match.b)} />

      <div className="tour-match__foot">
        {match.winnerId ? (
          <span className="dim small">
            {match.winBy && match.winBy !== "battle" ? `won by ${match.winBy}` : "played"}
          </span>
        ) : inProgress ? (
          <span className="tour-match__live">In progress</span>
        ) : match.deadlineAt != null ? (
          <span className={`dim small${overdue ? " tour-overdue" : ""}`}
                title={new Date(match.deadlineAt).toLocaleString()}>
            {overdue ? "deadline passed" : `due ${shortWhen(match.deadlineAt)}`}
          </span>
        ) : (
          <span className="dim small">waiting</span>
        )}

        {ready && (
          <span className="tour-match__actions">
            <button className="btn-primary btn-tiny" onClick={onStart} disabled={busy}>Start</button>
            {match.a.kind === "player" && (
              <button className="btn-ghost btn-tiny" title={`Award to ${slotLabel(match.a)} without playing`}
                      onClick={() => onResolve(match.id, (match.a as any).userId, slotLabel(match.a))}
                      disabled={busy}>↑</button>
            )}
            {match.b.kind === "player" && (
              <button className="btn-ghost btn-tiny" title={`Award to ${slotLabel(match.b)} without playing`}
                      onClick={() => onResolve(match.id, (match.b as any).userId, slotLabel(match.b))}
                      disabled={busy}>↓</button>
            )}
          </span>
        )}
      </div>
      {match.note && <div className="tour-match__note dim small">{match.note}</div>}
    </div>
  );
}

function Slot({ slot, won, lost }: { slot: BracketSlot; won: boolean; lost: boolean }) {
  const label = slot.kind === "player" ? (slot.username || slot.userId)
    : slot.kind === "bye" ? "bye"
    : slot.kind === "winnerOf" ? "TBD"
    : "—";
  return (
    <div className={`tour-slot${won ? " is-won" : ""}${lost ? " is-lost" : ""}${slot.kind !== "player" ? " is-empty" : ""}`}>
      {slot.kind === "player" && slot.seed != null && <span className="tour-seed">{slot.seed}</span>}
      <span className="tour-slot__name">{label}</span>
      {won && <span className="tour-slot__check" aria-label="winner">✓</span>}
    </div>
  );
}

// ─── Participants ────────────────────────────────────────────────────
function Participants({ tournament, busy, run }: {
  tournament: AdminTournament;
  busy: boolean;
  run: (label: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const [picked, setPicked] = useState<{ id: string; username: string } | null>(null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ id: string; username: string }[]>([]);
  const locked = tournament.status !== "open";

  // Search real accounts instead of a window.prompt. The old flow accepted
  // any string and only told you it was wrong after a round trip, which on a
  // username you half-remember is the worst possible moment to find out.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setOptions([]); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.listUsers(term, 0, 8)
        .then((d) => { if (!cancelled) setOptions(d.users.map((u) => ({ id: u.id, username: u.username }))); })
        .catch(() => { if (!cancelled) setOptions([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const alreadyIn = useMemo(
    () => new Set(tournament.entries.map((e) => e.username.toLowerCase())),
    [tournament.entries],
  );

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Participants</h2>
          <p>
            {tournament.entries.length} registered
            {locked && " · the entry list is frozen once the bracket is generated"}
          </p>
        </div>
      </header>

      {!locked && (
        <div className="tour-add">
          <Combobox
            value={query}
            onChange={(text) => { setQuery(text); setPicked(null); }}
            onSelect={(u) => { setPicked(u); setQuery(u.username); }}
            options={options}
            placeholder="Search a trainer by username…"
            getKey={(u) => u.id}
            getSearchText={(u) => u.username}
            renderOption={(u) => (
              <div className="tour-add__opt">
                <strong>{u.username}</strong>
                {alreadyIn.has(u.username.toLowerCase()) && <span className="dim small">already registered</span>}
              </div>
            )}
          />
          <button className="btn-primary btn-small"
                  disabled={busy || !picked || alreadyIn.has((picked?.username ?? "").toLowerCase())}
                  onClick={() => run("Add entry", async () => {
                    await api.addTournamentEntry(tournament.id, picked!.username);
                    setPicked(null); setQuery(""); setOptions([]);
                  })}>
            Add
          </button>
        </div>
      )}

      {tournament.entries.length === 0 ? (
        <p className="dim small">No participants yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Trainer</th>
                <th className="num">Seed</th>
                <th className="num">ELO at seed</th>
                <th>Status</th>
                <th className="actions"></th>
              </tr>
            </thead>
            <tbody>
              {tournament.entries.map((e) => (
                <tr key={e.id} className="is-clickable"
                    onClick={() => navigateTo("users", { userId: e.userId })}>
                  <td><strong>{e.username}</strong></td>
                  <td className="num">{e.seed ?? <span className="dim">—</span>}</td>
                  <td className="num dim">{e.ratingAtSeed ?? "—"}</td>
                  <td>
                    {e.eliminated
                      ? <span className="tag tag-bad">eliminated</span>
                      : <span className="tag tag-good">active</span>}
                  </td>
                  <td className="actions" onClick={(ev) => ev.stopPropagation()}>
                    {!locked && (
                      <button className="btn-ghost btn-tiny" disabled={busy}
                              onClick={async () => {
                                if (!await confirm(`Remove ${e.username} from this tournament?`)) return;
                                await run("Remove", () => api.removeTournamentEntry(tournament.id, e.id).then(() => undefined));
                              }}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Ad-hoc match ────────────────────────────────────────────────────
function AdHocMatch({ tournament, busy, run }: {
  tournament: AdminTournament;
  busy: boolean;
  run: (label: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <div className="tour-adhoc__body">
      <p className="dim small">
        Spawns a battle room with this tournament's level cap outside the bracket.
        Both players must be online with non-empty parties. The result does NOT feed
        back into the draw.
      </p>
      <div className="tour-adhoc__row">
        <select value={a} onChange={(e) => setA(e.target.value)}>
          <option value="">Player A…</option>
          {tournament.entries.map((e) => <option key={e.id} value={e.userId}>{e.username}</option>)}
        </select>
        <span className="dim">vs</span>
        <select value={b} onChange={(e) => setB(e.target.value)}>
          <option value="">Player B…</option>
          {/* A cannot also be B. The old version let you select the same
              person on both sides and only refused on submit. */}
          {tournament.entries.filter((e) => e.userId !== a).map((e) => (
            <option key={e.id} value={e.userId}>{e.username}</option>
          ))}
        </select>
        <button className="btn-secondary btn-small" disabled={busy || !a || !b || a === b}
                onClick={() => run("Start match", async () => {
                  const res = await api.startTournamentMatch(tournament.id, a, b);
                  setA(""); setB("");
                  return `Match started: ${res.battleId}`;
                })}>
          Start
        </button>
      </div>
    </div>
  );
}

// ─── Bracket types (mirror of server/src/lib/bracket.ts) ─────────────
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

/** Mirror of the server's status state machine (routes/admin.ts). Kept in
 *  sync by hand; the server is the authority and 409s anything else. */
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
  } catch { /* malformed bracket JSON reads as "no bracket" */ }
  return null;
}

function slotLabel(s: BracketSlot): string {
  if (s.kind === "player") return s.seed ? `#${s.seed} ${s.username || s.userId}` : (s.username || s.userId);
  if (s.kind === "bye") return "(bye)";
  if (s.kind === "winnerOf") return "TBD";
  return "—";
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** "24h", "90m", "3d" — short enough for a rail item. */
function formatWindow(minutes: number): string {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Relative when it is close, absolute when it is not — a deadline three
 *  days out is a date, one two hours out is "in 2h". */
function shortWhen(ts: number): string {
  const diff = ts - Date.now();
  const hrs = diff / 3_600_000;
  if (hrs < 1) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (hrs < 48) return `in ${Math.round(hrs)}h`;
  return new Date(ts).toLocaleDateString();
}
