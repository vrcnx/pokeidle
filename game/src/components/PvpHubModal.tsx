import { useEffect, useMemo, useState } from "react";
import { api, type RatingRow, type LeaderboardRow, type PvpHistoryRow, type PublicTournament } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { useGame } from "../state/GameContext";
import { useModalEnter } from "../utils/animate";
import {
  joinRandomQueue,
  leaveRandomQueue,
  usePvpState,
  listLiveBattles,
  joinSpectator,
  type LiveBattleSummary,
} from "../state/pvp";
import { openTeamBuilder } from "./TeamBuilderModal";
import { openReplay } from "./PvpReplayModal";
import { IconSwords, IconCrown, IconClose } from "./Icon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { PVP_TIERS, tierFor, tierProgress, ratingToNextTier } from "../state/pvpTiers";

// ──────────────────────────────────────────────────────────────────
//  Arena Card v2 — denser trainer-card lobby
// ──────────────────────────────────────────────────────────────────
//
// v1 review feedback: hero card was too sparse, a single sprite in a
// circle floating in a void with "UNRANKED" filling half the modal.
// v2 packs the same data into a horizontal trainer-card with team
// strip + stats grid, then a 2-col bottom row for match tape + top 3.

type Mode = "ranked" | "casual" | "tournament";

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
  // ALL HOOKS BEFORE THE EARLY RETURN — React #310 was caused by a
  // useMemo sitting below `if (!isOpen) return null`. Same hook
  // graph every render now.
  const isOpen = useOpen();
  const dialogRef = useModalEnter(".pvp-hero-trainer-card");
  const pvp = usePvpState();
  const game = useGame();
  const { me } = useAuth();

  const [rating, setRating]   = useState<RatingRow | null>(null);
  const [history, setHistory] = useState<PvpHistoryRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [liveBattles, setLiveBattles] = useState<LiveBattleSummary[]>([]);
  const [tournaments, setTournaments] = useState<PublicTournament[]>([]);
  const [mode, setMode] = useState<Mode>("ranked");
  const [tickerOpen, setTickerOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    setLoaded(false);
    Promise.allSettled([
      api.myRating(),
      api.myPvpHistory(20),
      api.pvpLeaderboard(50, 5),
      api.listTournaments(),
    ]).then(([r, h, l, t]) => {
      if (r.status === "fulfilled") setRating(r.value);
      if (h.status === "fulfilled") setHistory(h.value.matches);
      if (l.status === "fulfilled") setLeaderboard(l.value.leaderboard);
      if (t.status === "fulfilled") setTournaments(t.value.tournaments);
      setLoaded(true);
    });
    const refreshLive = () => {
      listLiveBattles((res) => { if (res.ok) setLiveBattles(res.battles ?? []); });
    };
    refreshLive();
    const interval = window.setInterval(() => {
      if (!document.hidden) refreshLive();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePvpHub(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const myRank = useMemo(() => {
    if (!me) return null;
    const idx = leaderboard.findIndex((r) => r.userId === me.id);
    return idx >= 0 ? leaderboard[idx].rank : null;
  }, [leaderboard, me]);

  const streak = useMemo(() => computeStreak(history), [history]);

  // ── End of hooks. Derived values + render below. ────────────────
  if (!isOpen) return null;

  const inBattle = !!pvp.room;
  const inQueue  = !!pvp.queue;
  const noTeam   = game.state.party.length + game.state.box.length < 1;
  const ratingValue = rating?.rating ?? 1000;
  const isUnranked = !!rating?.unranked;
  const tier = tierFor(ratingValue);
  const toNext = ratingToNextTier(ratingValue);

  const startMatch = () => {
    if (noTeam) return;
    closePvpHub();
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
      },
    });
  };
  const cancelQueue = () => leaveRandomQueue();

  const liveOnly = liveBattles.length > 0;
  const openTournaments = tournaments.filter((t) => t.status === "open" || t.status === "live");

  const wins   = rating?.wins   ?? history.filter((h) => h.result === "win").length;
  const losses = rating?.losses ?? history.filter((h) => h.result === "loss").length;
  const peak   = rating?.peakRating ?? ratingValue;

  // Player's 6-mon team for the strip.
  const teamForStrip = game.state.party.slice(0, 6);

  return (
    <div className="modal-overlay" onClick={closePvpHub}>
      <div
        ref={dialogRef}
        className={`g-modal pvp-hub-arena2 ${inQueue ? "is-queued" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="PvP battle hub"
      >
        {/* HEADER */}
        <header className="pvp2-head">
          <div className="pvp2-head-title">
            <IconSwords size={14} />
            <span>BATTLE HUB</span>
          </div>
          {!isUnranked && rating && (
            <span className="pvp2-elo-chip">{rating.matchesPlayed} matches</span>
          )}
          <button className="pvp2-close" onClick={closePvpHub} aria-label="Close">
            <IconClose size={18} />
          </button>
        </header>

        {/* TRAINER CARD — horizontal, packed with info */}
        <section className="pvp2-trainer-row">
          <article className="pvp-hero-trainer-card">
            {/* LEFT: portrait + tier badge */}
            <div className="pvp2-portrait-wrap">
              <div className="pvp2-portrait" style={{ boxShadow: `0 0 18px ${tier.glow}` }}>
                {teamForStrip[0] ? (
                  <img
                    src={pokemonSpriteUrl(teamForStrip[0].speciesKey, false, teamForStrip[0].isShiny)}
                    alt=""
                    width={72}
                    height={72}
                    style={{ imageRendering: "pixelated" }}
                  />
                ) : (
                  <span className="pvp2-portrait-empty">⚪</span>
                )}
              </div>
              {streak >= 3 && (
                <span className="pvp2-streak" title={`${streak} win streak`}>🔥{streak}</span>
              )}
            </div>

            {/* CENTER: identity + stats grid */}
            <div className="pvp2-identity">
              <div className="pvp2-name-row">
                <strong className="pvp2-name">{me?.name ?? me?.username ?? "Trainer"}</strong>
                <span
                  className="pvp2-tier-chip"
                  style={{ color: tier.color, boxShadow: `inset 0 0 0 1px ${tier.color}55, 0 0 10px ${tier.glow}` }}
                >
                  {isUnranked ? "UNRANKED" : tier.name.toUpperCase()}
                </span>
              </div>
              <div className="pvp2-stats">
                <div className="pvp2-stat">
                  <span className="pvp2-stat-label">RATING</span>
                  <strong className="tabular">{isUnranked ? "—" : ratingValue}</strong>
                </div>
                <div className="pvp2-stat">
                  <span className="pvp2-stat-label">W / L</span>
                  <strong className="tabular">{wins} / {losses}</strong>
                </div>
                <div className="pvp2-stat">
                  <span className="pvp2-stat-label">PEAK</span>
                  <strong className="tabular">{peak}</strong>
                </div>
                <div className="pvp2-stat">
                  <span className="pvp2-stat-label">STREAK</span>
                  <strong className="tabular">{streak > 0 ? `🔥 ${streak}` : "—"}</strong>
                </div>
              </div>
              {!isUnranked && toNext && (
                <div className="pvp2-next-tier">
                  <span className="dim small">Next tier in</span>
                  <strong>+{toNext.gap}</strong>
                  <span className="dim small">→ {toNext.next.name}</span>
                </div>
              )}
            </div>

            {/* RIGHT: team strip (6 mini sprites) */}
            <div className="pvp2-team-strip">
              <span className="pvp2-team-label">TEAM</span>
              <div className="pvp2-team-row">
                {Array.from({ length: 6 }).map((_, i) => {
                  const mon = teamForStrip[i];
                  return (
                    <div key={i} className={`pvp2-team-slot ${mon ? "filled" : "empty"} ${mon?.isShiny ? "is-shiny" : ""}`}>
                      {mon
                        ? (
                          <img
                            src={pokemonSpriteUrl(mon.speciesKey, false, mon.isShiny)}
                            alt=""
                            width={28}
                            height={28}
                            style={{ imageRendering: "pixelated" }}
                            title={`${mon.name} · Lv ${mon.level}`}
                          />
                        )
                        : <span aria-hidden>·</span>
                      }
                    </div>
                  );
                })}
              </div>
            </div>
          </article>
        </section>

        {/* MODE CHIPS + READY UP — tighter row, less hero space */}
        <section className="pvp2-cta">
          <div className="pvp-mode-chips" role="tablist" aria-label="Match mode">
            {(["ranked", "casual", "tournament"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`pvp-mode-chip ${mode === m ? "active" : ""}`}
                onClick={() => {
                  setMode(m);
                  if (m === "tournament") setTickerOpen(true);
                }}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <ReadyUpSlab
            inBattle={inBattle}
            inQueue={inQueue}
            noTeam={noTeam}
            mode={mode}
            onReady={startMatch}
            onCancel={cancelQueue}
          />
        </section>

        {/* 2-COL: LAST 10 + TOP 3 */}
        <section className="pvp2-row2">
          {/* Match tape — horizontal */}
          <div className="pvp2-panel pvp2-tape">
            <header className="pvp2-panel-head">
              <h4>LAST 10</h4>
              {history.length > 0 && (
                <span className="dim small">
                  {history.filter((h) => h.result === "win").length}W
                  {" "}{history.filter((h) => h.result === "loss").length}L
                </span>
              )}
            </header>
            {history.length === 0 ? (
              <p className="dim small pvp2-empty">No matches yet. Ready up to start your record.</p>
            ) : (
              <ul className="pvp2-pip-row">
                {history.slice(0, 10).map((m) => (
                  <li
                    key={m.id}
                    className={`pvp-pip pvp-pip-${m.result}`}
                    onClick={() => { closePvpHub(); openReplay(m.id); }}
                    title={`vs ${m.opponent.username} · ${m.result.toUpperCase()} · click to replay`}
                  >
                    <span className="pvp-pip-shape" />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Top 3 */}
          <div className="pvp2-panel pvp2-top3">
            <header className="pvp2-panel-head">
              <h4>TOP 3</h4>
              {myRank && <span className="dim small">YOU · #{myRank}</span>}
            </header>
            {leaderboard.length === 0 ? (
              <p className="dim small pvp2-empty">{loaded ? "No ranked players yet — be the first." : "Loading…"}</p>
            ) : (
              <ul className="pvp2-podium-list">
                {leaderboard.slice(0, 3).map((r) => (
                  <li key={r.userId} className={`pvp2-podium-row rank-${r.rank}`}>
                    <span className="pvp2-podium-rank">#{r.rank}</span>
                    {r.rank === 1 && <IconCrown size={12} className="pvp2-podium-crown" />}
                    <strong className="pvp2-podium-name">{r.name ?? r.username}</strong>
                    <span className="pvp2-podium-rating tabular">{r.rating}</span>
                  </li>
                ))}
                {me && !myRank && (
                  <li className="pvp2-podium-row pvp2-podium-you">
                    <span className="pvp2-podium-rank">YOU</span>
                    <strong className="pvp2-podium-name">{me.name ?? me.username}</strong>
                    <span className="pvp2-podium-rating tabular">{isUnranked ? "—" : ratingValue}</span>
                  </li>
                )}
              </ul>
            )}
          </div>
        </section>

        {/* LIVE BATTLES — conditional */}
        {liveOnly && (
          <section className="pvp2-live">
            <header className="pvp2-panel-head">
              <span className="pvp-live-dot" aria-hidden />
              <h4 style={{ color: "#fca5a5" }}>LIVE NOW</h4>
              <span className="dim small">{liveBattles.length} battle{liveBattles.length === 1 ? "" : "s"}</span>
            </header>
            <div className="pvp2-live-cards">
              {liveBattles.slice(0, 6).map((b) => {
                const isParticipant = !!me && (me.id === b.a.userId || me.id === b.b.userId);
                return (
                  <article key={b.battleId} className="pvp2-live-card">
                    <div className="pvp2-live-vs">
                      <span className="pvp2-live-trainer">{b.a.username}</span>
                      <span className="pvp2-live-vs-tag">VS</span>
                      <span className="pvp2-live-trainer">{b.b.username}</span>
                    </div>
                    <div className="dim small">{b.spectatorCount} watching</div>
                    <button
                      className="g-btn-primary g-btn-small"
                      disabled={isParticipant}
                      onClick={() => {
                        joinSpectator(b.battleId, (res) => {
                          if (!res.ok) {
                            window.alert(res.error ? `Couldn't watch: ${res.error}` : "Couldn't watch.");
                            return;
                          }
                          closePvpHub();
                        });
                      }}
                    >
                      Watch
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* TOURNAMENTS */}
        <section className={`pvp-tour-ticker ${tickerOpen ? "open" : ""}`}>
          <button
            className="pvp-tour-ticker-toggle"
            onClick={() => setTickerOpen((v) => !v)}
            aria-expanded={tickerOpen}
          >
            <span className="pvp-tour-icon">🏆</span>
            <span>TOURNAMENTS</span>
            <span className="dim small">· {openTournaments.length} open</span>
            <span className="pvp-tour-chev">{tickerOpen ? "▾" : "▸"}</span>
          </button>
          {tickerOpen && (
            <TournamentList list={tournaments} onChange={(t) => setTournaments(t)} />
          )}
        </section>

        {/* QUEUE OVERLAY */}
        {inQueue && (
          <div className="pvp-queue-overlay">
            <div className="pvp-queue-heartbeat">SCANNING FOR OPPONENT…</div>
            <button className="g-btn-ghost g-btn-small" onClick={cancelQueue}>Stand Down</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReadyUpSlab({
  inBattle, inQueue, noTeam, mode, onReady, onCancel,
}: {
  inBattle: boolean;
  inQueue:  boolean;
  noTeam:   boolean;
  mode: Mode;
  onReady:  () => void;
  onCancel: () => void;
}) {
  if (noTeam) {
    return (
      <button className="pvp-slab pvp-slab-warn" onClick={() => { closePvpHub(); openTeamBuilder({ mode: "queue", levelCap: 50, onConfirm: () => { /* user closes */ } }); }}>
        <span className="pvp-slab-title">BUILD A TEAM FIRST</span>
        <span className="pvp-slab-sub">You need at least one Pokémon</span>
      </button>
    );
  }
  if (inBattle) {
    return (
      <button className="pvp-slab pvp-slab-live" disabled>
        <span className="pvp-slab-dot" />
        <span className="pvp-slab-title">IN BATTLE</span>
        <span className="pvp-slab-sub">Return to your battle modal</span>
      </button>
    );
  }
  if (inQueue) {
    return (
      <button className="pvp-slab pvp-slab-queued" onClick={onCancel}>
        <span className="pvp-slab-title">STAND DOWN</span>
        <span className="pvp-slab-sub">Cancel queue</span>
      </button>
    );
  }
  if (mode === "tournament") {
    return (
      <button className="pvp-slab pvp-slab-secondary" disabled>
        <span className="pvp-slab-title">PICK A TOURNAMENT</span>
        <span className="pvp-slab-sub">Open the tournament list below</span>
      </button>
    );
  }
  return (
    <button className="pvp-slab" onClick={onReady}>
      <span className="pvp-slab-title">READY UP</span>
      <span className="pvp-slab-sub">{mode === "ranked" ? "Ranked · Lv 50" : "Casual · Friends only"}</span>
    </button>
  );
}

function TournamentList({ list, onChange }: { list: PublicTournament[]; onChange: (l: PublicTournament[]) => void }) {
  const { me } = useAuth();
  const [acting, setActing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () => {
    api.listTournaments()
      .then((d) => onChange(d.tournaments))
      .catch((e) => setMsg(e?.message ?? "Couldn't reload."));
  };
  const join = async (id: string) => {
    setActing(id); setMsg(null);
    try { await api.joinTournament(id); setMsg("Joined."); reload(); }
    catch (e: any) { setMsg(e?.message ?? "Couldn't join."); }
    finally { setActing(null); }
  };
  const leave = async (id: string) => {
    setActing(id); setMsg(null);
    try { await api.leaveTournament(id); setMsg("Withdrew."); reload(); }
    catch (e: any) { setMsg(e?.message ?? "Couldn't leave."); }
    finally { setActing(null); }
  };

  if (list.length === 0) {
    return <p className="dim small" style={{ padding: "12px 16px" }}>No tournaments scheduled right now.</p>;
  }
  return (
    <ul className="pvp-tour-list">
      {list.map((t) => {
        const joined = !!me && t.entries.some((e: any) => e.userId === me.id);
        const isOpen = t.status === "open";
        return (
          <li key={t.id} className="pvp-tour-row">
            <div className="pvp-tour-row-info">
              <strong>{t.name}</strong>
              <span className="dim small">
                {t.status.toUpperCase()} · {t.entries.length} entries
                {t.levelCap != null && ` · Lv ${t.levelCap}`}
              </span>
            </div>
            <div className="pvp-tour-row-actions">
              {joined ? (
                <button className="g-btn-ghost g-btn-small" disabled={acting === t.id || !isOpen} onClick={() => leave(t.id)}>
                  {acting === t.id ? "…" : "Withdraw"}
                </button>
              ) : (
                <button className="g-btn-primary g-btn-small" disabled={acting === t.id || !isOpen} onClick={() => join(t.id)}>
                  {acting === t.id ? "…" : "Join"}
                </button>
              )}
            </div>
          </li>
        );
      })}
      {msg && <li className="dim small pvp-tour-msg">{msg}</li>}
    </ul>
  );
}

function computeStreak(history: PvpHistoryRow[]): number {
  let s = 0;
  for (const m of history) {
    if (m.result === "win") s++;
    else break;
  }
  return s;
}

export { PVP_TIERS };
