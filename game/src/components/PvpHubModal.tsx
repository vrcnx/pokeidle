import { useEffect, useState } from "react";
import { api, type RatingRow, type LeaderboardRow, type PvpHistoryRow, type PublicTournament } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { useGame } from "../state/GameContext";
import { useModalEnter } from "../utils/animate";
import {
  joinRandomQueue,
  leaveRandomQueue,
  usePvpState,
} from "../state/pvp";
import { openTeamBuilder } from "./TeamBuilderModal";

// Player-facing PvP hub. Tabs:
//   Battle      — quick-action card to queue for random or
//                 nudge to challenge friends
//   My PvP      — rating, peak, W/L, recent match history
//   Leaderboard — top by rating
//   Tournaments — list of open / live tournaments + sign-up
//
// Module-scoped open() so the dock button can launch it.
type Tab = "battle" | "me" | "leaderboard" | "tournaments";

let _open = false;
const _listeners = new Set<(o: boolean) => void>();
export function openPvpHub() {
  _open = true;
  for (const l of _listeners) l(true);
}
export function closePvpHub() {
  _open = false;
  for (const l of _listeners) l(false);
}
function useOpen(): boolean {
  const [o, setO] = useState(_open);
  useEffect(() => {
    _listeners.add(setO);
    return () => { _listeners.delete(setO); };
  }, []);
  return o;
}

export function PvpHubModal() {
  const isOpen = useOpen();
  const dialogRef = useModalEnter(".g-card");
  const [tab, setTab] = useState<Tab>("battle");

  // Press Escape to close.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePvpHub();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={closePvpHub}>
      <div
        ref={dialogRef}
        className="g-modal pvp-hub-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="PvP hub"
      >
        <header className="g-modal-head">
          <h2>PvP</h2>
          <button className="g-modal-close" onClick={closePvpHub} aria-label="Close">×</button>
        </header>

        <nav className="pvp-hub-tabs" role="tablist">
          {(["battle", "me", "leaderboard", "tournaments"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`pvp-hub-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "battle"      ? "Battle"
                : t === "me"          ? "My PvP"
                : t === "leaderboard" ? "Leaderboard"
                :                       "Tournaments"}
            </button>
          ))}
        </nav>

        <div className="g-modal-body">
          {tab === "battle"      && <BattleTab />}
          {tab === "me"          && <MyPvpTab />}
          {tab === "leaderboard" && <LeaderboardTab />}
          {tab === "tournaments" && <TournamentsTab />}
        </div>
      </div>
    </div>
  );
}

// ─── Battle tab ────────────────────────────────────────────────────
function BattleTab() {
  const game = useGame();
  const pvp = usePvpState();
  const inBattle = !!pvp.room;
  const inQueue = !!pvp.queue;
  const noTeam = game.state.party.length + game.state.box.length < 1;

  const startRandom = () => {
    if (noTeam) return;
    openTeamBuilder({
      mode: "queue",
      levelCap: 50,
      onConfirm: (team) => {
        joinRandomQueue(team, (res) => {
          if (!res.ok) {
            window.alert(res.error ? `Couldn't queue: ${res.error}` : "Couldn't queue.");
            leaveRandomQueue();
          }
        });
        closePvpHub();
      },
    });
  };

  return (
    <div className="pvp-hub-tab-body">
      <section className="g-card g-card-full pvp-hub-action">
        <h3>Random Battle</h3>
        <p className="dim small">
          Queue up against another player at <strong>Lv 50</strong>. All Pokémon
          are clamped temporarily — your saved levels and progress are
          unchanged. Wins / losses count toward your rating.
        </p>
        <button
          className="g-btn-primary"
          onClick={startRandom}
          disabled={inBattle || inQueue || noTeam}
          title={
            inBattle ? "You're already in a battle"
            : inQueue ? "You're already in the queue"
            : noTeam ? "You need at least one Pokémon"
            : undefined
          }
        >
          {inQueue ? "In queue…" : inBattle ? "In battle…" : "Find a match"}
        </button>
      </section>

      <section className="g-card g-card-full pvp-hub-action">
        <h3>Challenge a friend</h3>
        <p className="dim small">
          Open <strong>Social → Friends</strong>, click a friend's name, then
          press <strong>Battle</strong>. Friend battles are <strong>casual</strong>
          {" "}— no level cap and no rating change.
        </p>
      </section>
    </div>
  );
}

// ─── My PvP (rating + history) tab ─────────────────────────────────
function MyPvpTab() {
  const [rating, setRating] = useState<RatingRow | null>(null);
  const [history, setHistory] = useState<PvpHistoryRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true);
    Promise.all([api.myRating(), api.myPvpHistory(20)])
      .then(([r, h]) => {
        setRating(r);
        setHistory(h.matches);
      })
      .catch((e) => setErr(e?.message ?? "Could not load."))
      .finally(() => setBusy(false));
  }, []);

  if (busy) return <p className="dim">Loading…</p>;
  if (err) return <p className="dim" style={{ color: "#fca5a5" }}>{err}</p>;

  return (
    <div className="pvp-hub-tab-body">
      <section className="g-card g-card-full pvp-rating-card">
        <h3>Your rating</h3>
        {rating?.unranked ? (
          <p className="dim">
            Unranked — play a Random Battle to set your rating.
          </p>
        ) : rating ? (
          <div className="pvp-rating-grid">
            <div><span>Rating</span><strong>{rating.rating}</strong></div>
            <div><span>Peak</span><strong>{rating.peakRating}</strong></div>
            <div><span>Wins</span><strong>{rating.wins}</strong></div>
            <div><span>Losses</span><strong>{rating.losses}</strong></div>
            <div><span>Forfeits</span><strong>{rating.forfeits}</strong></div>
            <div><span>Total matches</span><strong>{rating.matchesPlayed}</strong></div>
          </div>
        ) : null}
      </section>

      <section className="g-card g-card-full">
        <h3>Recent matches</h3>
        {history.length === 0 ? (
          <p className="dim">No PvP matches yet.</p>
        ) : (
          <ul className="pvp-history-list">
            {history.map((m) => (
              <li key={m.id} className={`pvp-history-row pvp-history-${m.result}`}>
                <span className="pvp-history-result">{m.result.toUpperCase()}</span>
                <span className="pvp-history-vs">vs <strong>{m.opponent.username}</strong></span>
                <span className="dim small">{formatLabel(m.format)}</span>
                <span className="dim small">{new Date(m.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function formatLabel(f: string): string {
  if (f === "random50")     return "Random Lv 50";
  if (f === "anything-goes") return "Casual";
  if (f === "tournament")    return "Tournament";
  return f;
}

// ─── Leaderboard tab ───────────────────────────────────────────────
function LeaderboardTab() {
  const { me } = useAuth();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBusy(true);
    api.pvpLeaderboard(50, 5)
      .then((d) => setRows(d.leaderboard))
      .catch((e) => setErr(e?.message ?? "Could not load."))
      .finally(() => setBusy(false));
  }, []);

  if (busy) return <p className="dim">Loading…</p>;
  if (err) return <p className="dim" style={{ color: "#fca5a5" }}>{err}</p>;

  return (
    <div className="pvp-hub-tab-body">
      <section className="g-card g-card-full">
        <h3>Top players <span className="dim small">(min 5 matches)</span></h3>
        {rows.length === 0 ? (
          <p className="dim">No ranked players yet — be the first.</p>
        ) : (
          <table className="pvp-leaderboard">
            <thead>
              <tr><th>#</th><th>Player</th><th>Rating</th><th>Peak</th><th>W / L</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className={me?.id === r.userId ? "me" : ""}>
                  <td>{r.rank}</td>
                  <td>
                    <strong>{r.name ?? r.username}</strong>
                    <span className="dim small"> @{r.username}</span>
                  </td>
                  <td><strong>{r.rating}</strong></td>
                  <td className="dim">{r.peakRating}</td>
                  <td className="dim small">{r.wins} / {r.losses}{r.forfeits ? ` (${r.forfeits} ff)` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ─── Tournaments tab ───────────────────────────────────────────────
function TournamentsTab() {
  const { me } = useAuth();
  const [list, setList] = useState<PublicTournament[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const reload = () => {
    setBusy(true);
    api.listTournaments()
      .then((d) => setList(d.tournaments))
      .catch((e) => setErr(e?.message ?? "Could not load."))
      .finally(() => setBusy(false));
  };
  useEffect(reload, []);

  const join = async (id: string) => {
    setActing(id); setActionMsg(null);
    try {
      await api.joinTournament(id);
      setActionMsg("Joined.");
      reload();
    } catch (e: any) {
      setActionMsg(e?.message ?? "Couldn't join.");
    } finally {
      setActing(null);
    }
  };
  const leave = async (id: string) => {
    setActing(id); setActionMsg(null);
    try {
      await api.leaveTournament(id);
      setActionMsg("Withdrew.");
      reload();
    } catch (e: any) {
      setActionMsg(e?.message ?? "Couldn't leave.");
    } finally {
      setActing(null);
    }
  };

  if (busy) return <p className="dim">Loading…</p>;
  if (err) return <p className="dim" style={{ color: "#fca5a5" }}>{err}</p>;

  if (list.length === 0) {
    return <p className="dim">No tournaments scheduled.</p>;
  }

  return (
    <div className="pvp-hub-tab-body">
      {actionMsg && <p className="dim small">{actionMsg}</p>}
      <ul className="pvp-tournament-list">
        {list.map((t) => {
          const joined = !!me && t.entries.some((e) => e.userId === me.id);
          const isOpen = t.status === "open";
          return (
            <li key={t.id} className={`pvp-tournament-row status-${t.status}`}>
              <div className="pvp-tournament-head">
                <strong>{t.name}</strong>
                <span className={`tag tournament-status-${t.status}`}>{t.status}</span>
              </div>
              <div className="dim small pvp-tournament-meta">
                {t.entries.length} player{t.entries.length === 1 ? "" : "s"}
                {t.levelCap != null && <> · Lv {t.levelCap} cap</>}
                <> · format {formatLabel(t.format)}</>
              </div>
              <div className="pvp-tournament-actions">
                {joined ? (
                  isOpen ? (
                    <button
                      className="g-btn-ghost g-btn-small"
                      onClick={() => leave(t.id)}
                      disabled={acting === t.id}
                    >
                      Withdraw
                    </button>
                  ) : (
                    <span className="dim small">You're entered.</span>
                  )
                ) : (
                  isOpen ? (
                    <button
                      className="g-btn-primary g-btn-small"
                      onClick={() => join(t.id)}
                      disabled={acting === t.id}
                    >
                      Join
                    </button>
                  ) : (
                    <span className="dim small">Not accepting entries.</span>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
