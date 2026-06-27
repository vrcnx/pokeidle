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
//  Arena Card — Fighter Lobby
// ──────────────────────────────────────────────────────────────────
// Tabs are dead. The hub is now a single layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │ Header: BATTLE HUB · ELO Δ chip · close                   │
//   ├──────────────┬─────────────────────────┬──────────────────┤
//   │ Match Tape   │  Trainer Card Hero      │  Top 3 Podium    │
//   │ (12 W/L pips)│  · username             │  · #2 / #1 / #3  │
//   │              │  · conic rating ring    │  · YOU · #N      │
//   │              │  · big rating numerals  │                  │
//   │              │  · tier + streak        │                  │
//   │              │                         │                  │
//   │              │  READY UP SLAB          │                  │
//   │              │  (mode chips + CTA)     │                  │
//   ├──────────────┴─────────────────────────┴──────────────────┤
//   │  LIVE NOW (conditional)                                   │
//   ├──────────────────────────────────────────────────────────┤
//   │  Tournament ticker (collapsed → expand)                   │
//   └──────────────────────────────────────────────────────────┘
//
// All five tabs of the old modal are reachable in zero clicks. No
// nav surface. The hub is the trainer-card + slab; everything else
// is conditional ambient.

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
  const isOpen = useOpen();
  const dialogRef = useModalEnter(".pvp-hub-arena, .pvp-hero-card");
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

  // Single batch load when the hub opens. Failures degrade silently —
  // the panel for whichever fetch failed shows an empty state.
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
    // Live battles refresh independently — separate poll loop below.
    const refreshLive = () => {
      listLiveBattles((res) => { if (res.ok) setLiveBattles(res.battles ?? []); });
    };
    refreshLive();
    const interval = window.setInterval(() => {
      if (!document.hidden) refreshLive();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [isOpen]);

  // Press Escape to close.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePvpHub(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  if (!isOpen) return null;

  const inBattle = !!pvp.room;
  const inQueue  = !!pvp.queue;
  const noTeam   = game.state.party.length + game.state.box.length < 1;
  const ratingValue = rating?.rating ?? 1000;
  const isUnranked = !!rating?.unranked;
  const tier = tierFor(ratingValue);
  const tierPct = tierProgress(ratingValue);
  const toNext = ratingToNextTier(ratingValue);

  // Streak detection from recent history (most recent first).
  const streak = computeStreak(history);
  // Player's lead Pokémon for the crest portrait.
  const leadSpecies = game.state.party[0]?.speciesKey ?? null;
  const leadShiny   = game.state.party[0]?.isShiny ?? false;
  const portraitUrl = leadSpecies ? pokemonSpriteUrl(leadSpecies, false, leadShiny) : null;

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

  // Where is the player on the leaderboard?
  const myRank = useMemo(() => {
    if (!me) return null;
    const idx = leaderboard.findIndex((r) => r.userId === me.id);
    return idx >= 0 ? leaderboard[idx].rank : null;
  }, [leaderboard, me]);

  const liveOnly = liveBattles.length > 0;
  const openTournaments = tournaments.filter((t) => t.status === "open" || t.status === "live");

  return (
    <div className="modal-overlay" onClick={closePvpHub}>
      <div
        ref={dialogRef}
        className={`g-modal pvp-hub-arena ${inQueue ? "is-queued" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="PvP battle hub"
      >
        {/* HEADER */}
        <header className="pvp-hub-head">
          <div className="pvp-hub-head-title">
            <IconSwords size={14} />
            <span>BATTLE HUB</span>
          </div>
          {!isUnranked && rating && (
            <span className="pvp-elo-chip">{rating.matchesPlayed} matches</span>
          )}
          <button className="pvp-hub-close" onClick={closePvpHub} aria-label="Close">
            <IconClose size={18} />
          </button>
        </header>

        {/* MAIN BODY — 3 columns: match tape / hero / podium */}
        <div className="pvp-hub-body">
          {/* LEFT RAIL — match tape */}
          <aside className="pvp-rail pvp-rail-left">
            <h4 className="pvp-rail-head">
              Last 10
              {history.length > 0 && (
                <span className="dim small">
                  {" "}· {history.filter((h) => h.result === "win").length}W
                  {" "}{history.filter((h) => h.result === "loss").length}L
                </span>
              )}
            </h4>
            {history.length === 0 ? (
              <p className="dim small pvp-rail-empty">No matches yet.</p>
            ) : (
              <ul className="pvp-match-tape">
                {history.slice(0, 12).map((m) => (
                  <li
                    key={m.id}
                    className={`pvp-pip pvp-pip-${m.result}`}
                    onClick={() => { closePvpHub(); openReplay(m.id); }}
                    title={`vs ${m.opponent.username} · ${m.result.toUpperCase()} · click to replay`}
                  >
                    <span className="pvp-pip-shape" />
                    <span className="pvp-pip-tip dim small">vs {m.opponent.username}</span>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* CENTER — hero card + READY UP slab */}
          <section className="pvp-hero">
            <article className="pvp-hero-card">
              {me && (
                <div className="pvp-hero-username">
                  {me.name ?? me.username}
                </div>
              )}
              <div
                className="pvp-hero-ring"
                style={{
                  background: isUnranked
                    ? "conic-gradient(rgba(255,255,255,0.18) 0deg, rgba(255,255,255,0.05) 360deg)"
                    : `conic-gradient(${tier.color} ${tierPct * 360}deg, rgba(255,255,255,0.06) ${tierPct * 360}deg)`,
                }}
                title={isUnranked ? "Play a Random Battle to set your rating" : toNext ? `Next tier in +${toNext.gap} rating` : "Max tier — Diamond"}
              >
                <div className="pvp-hero-crest" style={{ boxShadow: `0 0 24px ${tier.glow}` }}>
                  {portraitUrl ? (
                    <img src={portraitUrl} alt="" width={84} height={84} style={{ imageRendering: "pixelated" }} />
                  ) : (
                    <span className="pvp-hero-crest-empty">⚪</span>
                  )}
                  {streak >= 3 && (
                    <span className="pvp-hero-streak" title={`${streak} win streak`}>
                      🔥<small>{streak}</small>
                    </span>
                  )}
                </div>
              </div>
              <div className="pvp-hero-rating">
                {isUnranked ? (
                  <strong className="pvp-hero-unranked">UNRANKED</strong>
                ) : (
                  <>
                    <strong className="tabular">{ratingValue}</strong>
                    {rating && rating.peakRating > ratingValue && (
                      <span className="dim small">Peak {rating.peakRating}</span>
                    )}
                  </>
                )}
              </div>
              <div
                className="pvp-hero-tier"
                style={{ color: tier.color, textShadow: `0 0 12px ${tier.glow}` }}
              >
                {tier.name.toUpperCase()}
              </div>
              {rating && !isUnranked && (
                <div className="pvp-hero-record">
                  <span><strong className="tabular">{rating.wins}</strong> W</span>
                  <span className="pvp-hero-record-divider">·</span>
                  <span><strong className="tabular">{rating.losses}</strong> L</span>
                  {rating.forfeits > 0 && (
                    <>
                      <span className="pvp-hero-record-divider">·</span>
                      <span><strong className="tabular">{rating.forfeits}</strong> FF</span>
                    </>
                  )}
                </div>
              )}
            </article>

            {/* MODE CHIPS */}
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

            {/* READY UP SLAB */}
            <ReadyUpSlab
              inBattle={inBattle}
              inQueue={inQueue}
              noTeam={noTeam}
              mode={mode}
              onReady={startMatch}
              onCancel={cancelQueue}
            />
          </section>

          {/* RIGHT RAIL — podium */}
          <aside className="pvp-rail pvp-rail-right">
            <h4 className="pvp-rail-head">Top 3</h4>
            {leaderboard.length === 0 ? (
              <p className="dim small pvp-rail-empty">{loaded ? "No ranked players yet." : "Loading…"}</p>
            ) : (
              <>
                <div className="pvp-podium">
                  {leaderboard.slice(0, 3).map((r) => (
                    <div key={r.userId} className={`pvp-podium-tile rank-${r.rank}`}>
                      <span className="pvp-podium-rank">#{r.rank}</span>
                      {r.rank === 1 && <IconCrown size={14} className="pvp-podium-crown" />}
                      <strong className="pvp-podium-name">{r.name ?? r.username}</strong>
                      <span className="pvp-podium-rating tabular">{r.rating}</span>
                    </div>
                  ))}
                </div>
                {me && (
                  <div className={`pvp-you-chip ${myRank ? "" : "off-podium"}`}>
                    <span>YOU</span>
                    <span>{myRank ? `#${myRank}` : "Unranked"}</span>
                    <span className="tabular">{ratingValue}</span>
                  </div>
                )}
              </>
            )}
          </aside>
        </div>

        {/* LIVE NOW — conditional strip */}
        {liveOnly && (
          <section className="pvp-live-strip">
            <header className="pvp-live-strip-head">
              <span className="pvp-live-dot" aria-hidden />
              <strong>LIVE NOW</strong>
              <span className="dim small">{liveBattles.length} battle{liveBattles.length === 1 ? "" : "s"}</span>
            </header>
            <div className="pvp-live-cards">
              {liveBattles.slice(0, 6).map((b) => {
                const isParticipant = !!me && (me.id === b.a.userId || me.id === b.b.userId);
                return (
                  <article key={b.battleId} className="pvp-live-card">
                    <div className="pvp-live-vs">
                      <span className="pvp-live-trainer">{b.a.username}</span>
                      <span className="pvp-live-vs-tag">VS</span>
                      <span className="pvp-live-trainer">{b.b.username}</span>
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

        {/* TOURNAMENT TICKER */}
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

// ───────────────────────────────────────────────────────────────────
//  ReadyUp slab — state machine: noTeam / inBattle / inQueue / idle
// ───────────────────────────────────────────────────────────────────
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
      <button className="pvp-slab pvp-slab-secondary" onClick={() => { /* tournament ticker auto-opens */ }} disabled>
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

// ───────────────────────────────────────────────────────────────────
//  Tournament list expansion (inside the ticker)
// ───────────────────────────────────────────────────────────────────
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

// Re-export tier constants for any consumer that imports from this file.
export { PVP_TIERS };
