import { useEffect, useMemo, useState } from "react";
import { api, type RatingRow, type LeaderboardRow, type PvpHistoryRow, type PublicTournament } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { useGame } from "../state/GameContext";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import { openHub, closeHub } from "./HubModal";
import {
  joinRandomQueue,
  leaveRandomQueue,
  startBotBattle,
  listBotTrainers,
  type BotTrainerOption,
  usePvpState,
  listLiveBattles,
  joinSpectator,
  type LiveBattleSummary,
} from "../state/pvp";
import { openTeamBuilder, TeamBuilderPane } from "./TeamBuilderModal";
import { openReplay } from "./PvpReplayModal";
import { IconSwords, IconCrown, IconClose } from "./Icon";
import { PokemonSprite } from "./Sprite";
import { PVP_TIERS, tierFor, ratingToNextTier } from "../state/pvpTiers";
// The offer below reuses .pvp-queue-overlay / .pvp-slab / .pvp-mode-chip from
// app.css and adds only two new rules, which live in pvpArena.css. Vite dedupes
// this against PvpArena.tsx's own import of the same file.
import "../pvpArena.css";

// ──────────────────────────────────────────────────────────────────
//  Arena Card v2 — denser trainer-card lobby
// ──────────────────────────────────────────────────────────────────
//
// v1 review feedback: hero card was too sparse, a single sprite in a
// circle floating in a void with "UNRANKED" filling half the modal.
// v2 packs the same data into a horizontal trainer-card with team
// strip + stats grid, then a 2-col bottom row for match tape + top 3.

// Casual is gone. It was a chip that queued into the SAME matchmaking pool
// as ranked and then declined to pay out — a second door to one room, where
// the only difference was that walking through it wasted the match. With a
// population this size every real battle should count.
type Mode = "ranked" | "tournament" | "practice";

/** How long a player has to be alone in the queue before the AI is offered.
 *
 *  ~7 passes of the 3-second server-side matchmaking ticker. Short enough that
 *  a 3 a.m. player is not abandoned, long enough that it never appears in front
 *  of someone who was about to be matched — which is the thing that would make
 *  the real queue feel worse rather than better. */
const LONELY_QUEUE_MS = 20_000;

/** Open the hub on Battle. Kept as a named entry point so callers that mean
 *  "take me to PvP" still say so — see HubModal's note on openGiveaways. */
export function openPvpHub() { openHub("pvp"); }
export function closePvpHub() { closeHub(); }

/**
 * The Battle PANE.
 *
 * `isOpen` used to be this component's own module-level flag, and it did two
 * jobs: gate the render, and gate a dozen "don't act while closed" checks on
 * queue and tournament buttons. The hub only mounts a section while it is
 * the active one, so the render gate is gone — but the action guards are not
 * dead weight, they stop an in-flight request from acting after the player
 * has navigated away, so `isOpen` survives as a constant true and the guards
 * keep their meaning.
 */
export function PvpHubPane() {
  const isOpen = true;
  // Editing the team is a MODE of this pane, not another dialog on top of
  // it. The hub exists because four stacked modals were a pile; opening a
  // fifth from inside it would be the same mistake one level down.
  const [editingTeam, setEditingTeam] = useState(false);
  const pvp = usePvpState();
  const game = useGame();
  const { me } = useAuth();
  const t = useT();

  const [rating, setRating]   = useState<RatingRow | null>(null);
  const [history, setHistory] = useState<PvpHistoryRow[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [liveBattles, setLiveBattles] = useState<LiveBattleSummary[]>([]);
  const [tournaments, setTournaments] = useState<PublicTournament[]>([]);
  const [mode, setMode] = useState<Mode>("ranked");
  const [loaded, setLoaded] = useState(false);
  // Wall clock, ticked only while queued, so the "you are alone" offer below
  // can appear on its own after LONELY_QUEUE_MS instead of needing the player
  // to cause a re-render.
  const [now, setNow] = useState(() => Date.now());
  // "Keep waiting" is honoured for THIS wait only — it resets when they
  // requeue, because the next wait is a new decision.
  const [offerDismissed, setOfferDismissed] = useState(false);
  const [botTrainers, setBotTrainers] = useState<BotTrainerOption[]>([]);
  // Who the SERVER says is the fair fight for this party, and who the player
  // has chosen instead. null = "use the recommendation", which is what the
  // permanent PRACTICE slab sends.
  const [botRecommended, setBotRecommended] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) { setLoaded(false); return; }
    setLoaded(false);
    Promise.allSettled([
      api.myRating(),
      api.myPvpHistory(20),
      // minMatches 1, not 5. routes/pvp.ts lowered the SERVER default to 1
      // and documented why — the maximum matchesPlayed across every
      // PlayerRating row in production is 1, so a filter of 5 returns an
      // empty array. The server default was fixed; this call site kept
      // overriding it with the old value, so the board read "No ranked
      // players yet" while four rated players sat in the table.
      api.pvpLeaderboard(50, 1),
      api.listTournaments(),
    ]).then(([r, h, l, t]) => {
      if (r.status === "fulfilled") setRating(r.value);
      if (h.status === "fulfilled") setHistory(h.value.matches);
      if (l.status === "fulfilled") setLeaderboard(l.value.leaderboard);
      if (t.status === "fulfilled") setTournaments(t.value.tournaments);
      setLoaded(true);
    });
    // Who the AI can be, and which of them is a FAIR fight for this party.
    //
    // The party summary (levels + species only) is what lets the server rank
    // them, and ranking is the fix for a real defect rather than decoration:
    // the trainer used to be rolled uniformly at random, and measured against
    // 2,309 production parties one of the eight won 100% of low-level battles
    // while another won 6% of high-level ones. Now the offer names the
    // recommended opponent and the picker says which choices are matched.
    const summary = game.state.party
      .slice(0, 6)
      .map((m) => ({ level: m.level, speciesKey: m.speciesKey }));
    listBotTrainers(summary, (res) => {
      if (!res.ok) return;
      setBotTrainers(res.trainers ?? []);
      setBotRecommended(res.recommended ?? null);
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeHub(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const queuedAt = pvp.queue?.joinedAt ?? null;
  useEffect(() => {
    setOfferDismissed(false);
    if (!isOpen || queuedAt == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [isOpen, queuedAt]);

  const myRank = useMemo(() => {
    if (!me) return null;
    const idx = leaderboard.findIndex((r) => r.userId === me.id);
    return idx >= 0 ? leaderboard[idx].rank : null;
  }, [leaderboard, me]);

  const streak = useMemo(() => computeStreak(history), [history]);

  // The trainer named in the queue offer, and the one actually passed to the
  // server, so the name in the offer is the name you fight.
  //
  // This used to be `botTrainers[Math.floor(Math.random() * length)]`, and the
  // uniform roll was the defect: the eight rosters were fixed early-game teams,
  // so at max party level <=10 the roll decided the battle (Ace Trainer AI won
  // 100% of measured battles, Bug Catcher AI 38%) and at Lv 60+ seven of the
  // eight were a punching bag. The server now ranks them for THIS party and the
  // offer takes its recommendation — the variety comes from the server picking
  // among the trainers that genuinely fit, not from a die roll here.
  const offerTrainer = useMemo(
    () => botTrainers.find((t) => t.id === botRecommended) ?? botTrainers[0] ?? null,
    [botTrainers, botRecommended],
  );

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
            window.alert(res.error ? `Couldn't queue: ${res.error}` : t("Couldn't queue."));
            leaveRandomQueue();
          }
        });
      },
    });
  };
  const cancelQueue = () => leaveRandomQueue();

  /** What to say about an AI opponent in the picker.
   *
   *  `matched` is the SERVER's own verdict — the same two thresholds pickTrainer
   *  applies when it chooses for you — so this never claims a fight is fair that
   *  the server would not itself have offered. `edge` is only used to explain
   *  WHY an unmatched one is unmatched, and every entry gets a note: an opponent
   *  the matcher could not fit to your team with no explanation attached is the
   *  silent version of the problem this picker exists to fix. */

  // AI practice. Deliberately NO levelCap on the picker: the server matches the
  // bot to your team slot-for-slot, so there is nothing to normalise and
  // showing a "Lv 50 cap" hint would be wrong for the 87% of players whose
  // whole party is under 50.
  const startPractice = (trainer?: string) => {
    if (noTeam) return;
    closePvpHub();
    openTeamBuilder({
      mode: "queue",
      onConfirm: (team) => {
        startBotBattle(team, { trainer }, (res) => {
          if (!res.ok) {
            window.alert(res.error ? `Couldn't start practice: ${res.error}` : t("Couldn't start practice."));
          }
        });
      },
    });
  };

  // "Nobody is there" is the NORMAL outcome of joining a FIFO queue in a game
  // with ~34 active players an hour, so the offer is gated on being able to
  // PROVE it rather than on a hunch: the server broadcasts the live queue size
  // on every mutation (battle:queue:update), and joinedAt is when we arrived.
  const aloneInQueue =
    inQueue && !offerDismissed && (pvp.queue?.queueSize ?? 1) <= 1
    && now - (pvp.queue?.joinedAt ?? now) > LONELY_QUEUE_MS;

  const liveOnly = liveBattles.length > 0;
  const openTournaments = tournaments.filter((t) => t.status === "open" || t.status === "live");

  const wins   = rating?.wins   ?? history.filter((h) => h.result === "win").length;
  const losses = rating?.losses ?? history.filter((h) => h.result === "loss").length;
  // Forfeits are their own column server-side and count in NEITHER wins nor
  // losses, so a player who forfeited once saw "984 · 0/0": a rating that had
  // visibly moved beside a record claiming nothing had happened. Shown only
  // when non-zero — a "/ 0" on every card would be noise for the 3 of 4 rated
  // players who have never forfeited.
  const forfeits = rating?.forfeits ?? 0;
  const peak   = rating?.peakRating ?? ratingValue;

  // Player's 6-mon team for the strip.
  const teamForStrip = game.state.party.slice(0, 6);

  if (editingTeam) {
    return (
      <div className="pvp-hub-pane pvp-hub-pane--editing">
        <header className="pvp2-edit-head">
          <button className="g-btn-ghost g-btn-small" onClick={() => setEditingTeam(false)}>
            {"←"} {t("Back to Battle")}
          </button>
          <h3>{t("Your battle team")}</h3>
        </header>
        <TeamBuilderPane
          levelCap={50}
          onConfirm={() => setEditingTeam(false)}
          onCancel={() => setEditingTeam(false)}
        />
      </div>
    );
  }

  return (
    <div className={`pvp-hub-pane ${inQueue ? "is-queued" : ""}`}>


        {/* MODE CHIPS + READY UP — tighter row, less hero space */}
        {/* The arena, on the hub's own column system: the thing you came to
            press on the left, the standings that tell you whether pressing it
            is going well on the right. Stacked, these were a 900px column of
            half-empty rows with the bottom third of the pane blank. */}
        <div className="hub-split pvp2-body">
        <section className="pvp2-arena">
          {/* Who you are, at the top of the arena rather than in a full-width
              card above it. The card spanned both columns while everything
              under it was two — a T that lined up with nothing — and once the
              team strip moved down here it had 278px of empty right side. */}
          <article className="pvp-hero-trainer-card">
            {/* LEFT: portrait + tier badge */}
            <div className="pvp2-portrait-wrap">
              <div className="pvp2-portrait" style={{ boxShadow: `0 0 18px ${tier.glow}` }}>
                {teamForStrip[0] ? (
                  <PokemonSprite
                    speciesKey={teamForStrip[0].speciesKey}
                    isShiny={teamForStrip[0].isShiny}
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
                <strong className="pvp2-name">{me?.name ?? me?.username ?? t("Trainer")}</strong>
                <span
                  className="pvp2-tier-chip"
                  style={{ color: tier.color, boxShadow: `inset 0 0 0 1px ${tier.color}55, 0 0 10px ${tier.glow}` }}
                >
                  {isUnranked ? t("UNRANKED") : tier.name.toUpperCase()}
                </span>
              </div>
              {/* THE number, at the size it deserves.
                  It used to be one of four equal columns — RATING, W/L, PEAK,
                  STREAK — each with a 9px caps label and a 15px value, so the
                  one figure the whole mode is organised around had exactly the
                  same weight as how many times you have forfeited. Rating
                  leads, in its own tier's colour; everything else is the line
                  underneath that qualifies it. */}
              <div className="pvp2-rating-block">
                <strong className="pvp2-rating" style={{ color: isUnranked ? "var(--text-muted)" : tier.color }}>
                  {isUnranked ? "—" : ratingValue}
                </strong>
                <span className="pvp2-rating-label">{t("RATING")}</span>
                {!isUnranked && peak > ratingValue && (
                  <span className="pvp2-rating-peak">{t("peak")} <strong>{peak}</strong></span>
                )}
              </div>

              {/* The record, as a sentence rather than a grid. Zeroes read as
                  "no matches yet" instead of three columns of nothing. */}
              <p className="pvp2-record">
                {wins + losses + forfeits === 0
                  ? <span className="dim">{t("No ranked matches yet")}</span>
                  : (
                    <>
                      <span className="pvp2-rec-w"><strong>{wins}</strong>{t("W")}</span>
                      <span className="pvp2-rec-l"><strong>{losses}</strong>{t("L")}</span>
                      {forfeits > 0 && <span className="pvp2-rec-f"><strong>{forfeits}</strong>{t("FF")}</span>}
                      {streak > 0 && <span className="pvp2-rec-streak">🔥 {streak}{t(" in a row")}</span>}
                    </>
                  )}
              </p>

              <TierTrack rating={ratingValue} unranked={isUnranked} />
            </div>

          </article>

          {/* MODE - two cards, not two pills in a bar.
              It was a full-width dark strip holding two small chips, so most
              of it was empty and the choice read as an afterthought floating
              over the artwork. There are only ever two or three modes and
              they differ in the one way a player cares about - whether the
              result counts - so each says so on its own face instead of
              making them read the button underneath to find out. */}
          <div className="pvp2-modes" role="tablist" aria-label={t("Match mode")}>
            {((openTournaments.length > 0
                ? ["ranked", "tournament", "practice"]
                : ["ranked", "practice"]) as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`pvp2-mode${mode === m ? " is-active" : ""}`}
                onClick={() => setMode(m)}
              >
                <span className="pvp2-mode-icon" aria-hidden>{MODE_ICON[m]}</span>
                <span className="pvp2-mode-text">
                  <span className="pvp2-mode-name">{t(MODE_LABEL[m])}</span>
                  <span className="pvp2-mode-note">{t(MODE_NOTE[m])}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="pvp2-arena-core">
          <ReadyUpSlab
            inBattle={inBattle}
            inQueue={inQueue}
            noTeam={noTeam}
            mode={mode}
            stake={mode === "ranked" && !isUnranked ? EVEN_MATCH_SWING : null}
            onReady={
              mode === "practice"
                ? () => startPractice(botRecommended ?? undefined)
                : startMatch
            }
            onCancel={cancelQueue}
          />
          {/* The opponent picker is gone. The server already ranks the bot
              roster against the player's party and names a fair one — the
              dropdown existed only to expose that ranking, and what it
              actually showed was one recommended trainer above seven lines
              reading "not matched to your team". Offering seven bad choices
              to make one good one look good is not a choice. Practice now
              takes the recommendation. */}
          </div>
          {/* RIGHT: the team, and a way in to change it.
              Six sprites in the corner that did nothing. Every other game
              puts the lineup where you manage the lineup, and this screen
              already has a team builder one button away — it just opened
              from READY UP, mid-commitment, which is the worst moment to
              discover you brought the wrong Pokémon. Clicking the strip
              opens the same builder with nothing at stake. */}
          <button
            type="button"
            className="pvp2-team"
            onClick={() => setEditingTeam(true)}
            title={t("Edit your battle team")}
          >
            <span className="pvp2-team-head">
              <span className="pvp2-team-title">{t("YOUR TEAM")}</span>
              <span className="pvp2-team-count">
                {teamForStrip.length}/6 {"·"} {t("capped at Lv 50")}
              </span>
              <span className="pvp2-team-edit">{t("Edit")}</span>
            </span>
            <span className="pvp2-team-row">
              {Array.from({ length: 6 }).map((_, i) => {
                const mon = teamForStrip[i];
                return (
                  <span
                    key={i}
                    className={`pvp2-slot ${mon ? "filled" : "empty"} ${mon?.isShiny ? "is-shiny" : ""}`}
                    title={mon ? `${mon.name} · Lv ${mon.level}` : t("Empty slot")}
                  >
                    {mon
                      ? (
                        <>
                          <PokemonSprite
                            speciesKey={mon.speciesKey}
                            isShiny={mon.isShiny}
                            alt=""
                            width={44}
                            height={44}
                            style={{ imageRendering: "pixelated" }}
                          />
                          {/* The level a slot will actually FIGHT at. Ranked
                              caps at 50, so a Lv 100 in the party is not the
                              advantage the party screen implies, and this is
                              the only place that number is honest. */}
                          <span className="pvp2-slot-lv">{Math.min(50, mon.level)}</span>
                        </>
                      )
                      : <span className="pvp2-slot-dot" aria-hidden />
                    }
                  </span>
                );
              })}
            </span>
          </button>
        </section>

        {/* Form and standings — a column beside the CTA, not a row under it. */}
        <aside className="pvp2-side">
          {/* Match tape — horizontal */}
          <div className="pvp2-panel pvp2-tape">
            <header className="pvp2-panel-head">
              <h4>{t("RECENT MATCHES")}</h4>
              {history.length > 0 && (
                <span className="dim small">
                  {history.filter((h) => h.result === "win").length}W
                  {" "}{history.filter((h) => h.result === "loss").length}L
                </span>
              )}
            </header>
            {history.length === 0 ? (
              <p className="dim small pvp2-empty">{t("No matches yet. Ready up to start your record.")}</p>
            ) : (
              /* Rows, not pips. Ten coloured diamonds tell you the SHAPE of a
                 run and nothing else — not who beat you, not when, not whether
                 the loss was a real fight or a timeout. Every one of those is
                 already on the history row the client fetches; the pips were
                 throwing it away.
                 There is deliberately no rating delta: nothing stores one.
                 PvpMatch has no column for it and the history DTO has no
                 field, so a number here would be invented. */
              <ul className="pvp2-match-list">
                {history.slice(0, 8).map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`pvp2-match pvp2-match--${m.result}`}
                      onClick={() => { closePvpHub(); openReplay(m.id); }}
                      title={t("Watch the replay")}
                    >
                      <span className={`pvp2-match-mark pvp2-match-mark--${m.result}`} aria-hidden>
                        {m.result === "win" ? "W" : m.result === "loss" ? "L" : m.result === "draw" ? "D" : "F"}
                      </span>
                      <span className="pvp2-match-who">
                        <span className="pvp2-match-opp">{m.opponent.username}</span>
                        <span className="pvp2-match-meta">
                          {matchWhen(m, now)}
                          {m.endReason && m.endReason !== "ko" && <> · {endReasonLabel(m.endReason, t)}</>}
                        </span>
                      </span>
                      <span className="pvp2-match-play" aria-hidden>▶</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Top 3 */}
          <div className="pvp2-panel pvp2-top3">
            <header className="pvp2-panel-head">
              <h4>{t("LADDER")}</h4>
              {leaderboard.length > 0 && (
                <span className="dim small">
                  {leaderboard.length} {leaderboard.length === 1 ? t("rated") : t("rated")}
                </span>
              )}
            </header>
            {leaderboard.length === 0 ? (
              <p className="dim small pvp2-empty">{loaded ? t("No ranked players yet — be the first.") : t("Loading…")}</p>
            ) : (
              <ul className="pvp2-podium-list">
                {leaderboard.slice(0, 5).map((r) => (
                  <li key={r.userId} className={`pvp2-podium-row rank-${r.rank}${me && r.userId === me.id ? " is-you" : ""}`}>
                    <span className="pvp2-podium-rank">#{r.rank}</span>
                    {r.rank === 1 && <IconCrown size={12} className="pvp2-podium-crown" />}
                    <strong className="pvp2-podium-name">{r.name ?? r.username}</strong>
                    <span className="pvp2-podium-rating tabular">{r.rating}</span>
                  </li>
                ))}
                {me && (myRank == null || myRank > 5) && (
                  <li className="pvp2-podium-row pvp2-podium-you">
                    <span className="pvp2-podium-rank">{myRank ? `#${myRank}` : t("YOU")}</span>
                    <strong className="pvp2-podium-name">{me.name ?? me.username}</strong>
                    <span className="pvp2-podium-rating tabular">{isUnranked ? "—" : ratingValue}</span>
                  </li>
                )}
              </ul>
            )}
          </div>
          {/* TOURNAMENTS — only when there is one.
              It was a section that rendered every day to say no tournament
              was scheduled, which is a box explaining its own absence. When
              one IS running it is the biggest event in the mode and shows
              itself; the rest of the time the rail is shorter, which is the
              correct amount of space for nothing. */}
          {tournaments.length > 0 && (
            <section className="pvp-tour">
              <header className="pvp2-panel-head">
                <span className="pvp-tour-icon" aria-hidden>🏆</span>
                <h4>{t("TOURNAMENTS")}</h4>
                {openTournaments.length > 0 && (
                  <span className="pvp-tour-count">{openTournaments.length} {t("open")}</span>
                )}
              </header>
              <TournamentList list={tournaments} onChange={(t) => setTournaments(t)} />
            </section>
          )}
        </aside>
        </div>

        {/* LIVE BATTLES — conditional */}
        {liveOnly && (
          <section className="pvp2-live">
            <header className="pvp2-panel-head">
              <span className="pvp-live-dot" aria-hidden />
              <h4 style={{ color: "#fca5a5" }}>{t("LIVE NOW")}</h4>
              <span className="dim small">{liveBattles.length} battle{liveBattles.length === 1 ? "" : "s"}</span>
            </header>
            <div className="pvp2-live-cards">
              {liveBattles.slice(0, 6).map((b) => {
                const isParticipant = !!me && (me.id === b.a.userId || me.id === b.b.userId);
                return (
                  <article key={b.battleId} className="pvp2-live-card">
                    <div className="pvp2-live-vs">
                      <span className="pvp2-live-trainer">{b.a.username}</span>
                      <span className="pvp2-live-vs-tag">{t("VS")}</span>
                      <span className="pvp2-live-trainer">{b.b.username}</span>
                    </div>
                    <div className="dim small">{b.spectatorCount} {t("watching")}</div>
                    <button
                      className="g-btn-primary g-btn-small"
                      disabled={isParticipant}
                      onClick={() => {
                        joinSpectator(b.battleId, (res) => {
                          if (!res.ok) {
                            window.alert(res.error ? `Couldn't watch: ${res.error}` : t("Couldn't watch."));
                            return;
                          }
                          closePvpHub();
                        });
                      }}
                    >
                      {t("Watch")}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* QUEUE OVERLAY
            The scan keeps running underneath. The AI offer is an ADDITION to a
            wait that is still live, never a replacement for it — "Keep waiting"
            does nothing at all because nothing was ever cancelled. */}
        {inQueue && (
          <div className="pvp-queue-overlay">
            <div className="pvp-queue-heartbeat">{t("SCANNING FOR OPPONENT…")}</div>
            {/* How long, and who else is looking.
                The overlay said "scanning" and nothing else, so a wait that
                is going nowhere looked exactly like a wait that is about to
                land — and with ~8 of 10 queue attempts never matching, going
                nowhere is the common case. Both numbers are already on the
                client: the socket sends queueSize on join and on every
                change, and joinedAt is when this wait started. */}
            <QueueVitals joinedAt={queuedAt} queueSize={pvp.queue?.queueSize ?? 1} />
            {aloneInQueue && (
              <div className="pvp2-lonely-offer" role="status">
                <strong>{t("No one else is in the queue right now.")}</strong>
                <span className="dim small">
                  {offerTrainer
                    ? <>{t("Fight")} <strong>{offerTrainer.label}</strong> {t("instead?")}</>
                    : t("Fight a computer opponent instead?")}
                  {/* "levels" alone was true and incomplete, which made the
                      offer read as fairer than it was: the trainer used to be
                      rolled at random over fixed early-game teams, so a
                      level-matched Gyarados could turn up against a Lv 7 party.
                      The server now matches the opponent's POWER as well and
                      picks a trainer that fits, so the offer can say so. */}
                  {" "}{t("Their Pokémon are matched to your team's levels and power.")}
                </span>
                <span className="dim small">{t("AI practice battle — not rated, no rank change.")}</span>
                <div className="pvp2-lonely-actions">
                  {/* Deliberately does NOT dequeue first. battle:bot dequeues
                      server-side only once it has actually started the battle,
                      so backing out of the team picker leaves the player exactly
                      where they were — still queued — instead of costing them
                      their slot for changing their mind. And if a human turns up
                      while the picker is open, they get the human. */}
                  <button
                    className="g-btn-primary g-btn-small"
                    onClick={() => startPractice(offerTrainer?.id)}
                  >
                    {t("Fight the AI")}
                  </button>
                  <button className="g-btn-ghost g-btn-small" onClick={() => setOfferDismissed(true)}>
                    {t("Keep waiting")}
                  </button>
                </div>
              </div>
            )}
            <button className="g-btn-ghost g-btn-small" onClick={cancelQueue}>{t("Stand Down")}</button>
          </div>
        )}
    </div>
  );
}

/**
 * "34 matches", for the hub header. The pane's own header is gone and this is
 * the one thing from it worth keeping at the top.
 *
 * It fetches its own rating rather than taking one as a prop. The pane is
 * already fetching the same row a few lines below, so this is a second
 * request for one number — but the alternative is lifting PvP's whole rating
 * state up into GameHub so it can be threaded back down into a header slot,
 * which would make the hub's assembly file know what an Elo row is. One
 * cached GET is the cheaper trade.
 */
export function PvpHeaderRight() {
  const t = useT();
  const [matches, setMatches] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.myRating()
      .then((r) => { if (alive) setMatches(r?.matchesPlayed ?? null); })
      // No chip. A header ornament is not worth an error state.
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, []);
  if (matches == null) return null;
  return (
    <span className="pvp2-elo-chip">
      {matches} {matches === 1 ? t("match") : t("matches")}
    </span>
  );
}

/**
 * What an evenly-matched ranked game is worth, both ways.
 *
 * Elo with K=32 pays K x (1 - expected); two players on the same rating each
 * expect 0.5, so the swing is 16 — and 16 is exactly what the one forfeited
 * match in production moved a rating by, which is why it is the number a
 * player will recognise rather than a range they have to interpret.
 */
const EVEN_MATCH_SWING = 16;

/** What each mode is called, and the one thing that distinguishes it.
 *  The note is always about whether the result COUNTS, because that is the
 *  only difference a player is actually choosing between. */
const MODE_LABEL: Record<Mode, string> = {
  ranked: "Ranked",
  tournament: "Tournament",
  practice: "Practice",
};
const MODE_NOTE: Record<Mode, string> = {
  ranked: "Rated · Lv 50 · counts",
  tournament: "Bracketed · own prizes",
  practice: "Versus AI · never rated",
};
const MODE_ICON: Record<Mode, string> = {
  ranked: "⚔",
  tournament: "★",
  practice: "◎",
};

/** "3h ago" for a match row. Falls back to the date once a run is old
 *  enough that "9d ago" stops meaning anything. */
function matchWhen(m: { finishedAt: string | null; createdAt: string }, now: number): string {
  const at = new Date(m.finishedAt ?? m.createdAt).getTime();
  if (!Number.isFinite(at)) return "";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Only shown when the match did NOT end by knockout — "ko" is the
 *  default way a battle finishes and saying so on every row is noise. */
function endReasonLabel(reason: string, t: (s: string) => string): string {
  switch (reason) {
    case "forfeit": return t("forfeit");
    case "timeout": return t("timed out");
    case "tie":     return t("tie");
    case "cancelled": return t("cancelled");
    default: return reason;
  }
}

/**
 * "0:42 · you're the only one searching".
 *
 * Ticks once a second, and only while it is mounted — which is only while
 * the player is actually in the queue, so an idle hub costs no timer.
 */
function QueueVitals({ joinedAt, queueSize }: { joinedAt: number | null; queueSize: number }) {
  const t = useT();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const secs = joinedAt ? Math.max(0, Math.floor((Date.now() - joinedAt) / 1000)) : 0;
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, "0");
  // queueSize counts everyone waiting INCLUDING this player, so "others" is
  // the honest word for what is left after removing them.
  const others = Math.max(0, queueSize - 1);
  return (
    <p className="pvp-queue-vitals">
      <span className="pvp-queue-clock tabular">{mm}:{ss}</span>
      <span className="pvp-queue-sep" aria-hidden>·</span>
      <span className="dim">
        {others === 0
          ? t("you're the only one searching")
          : `${others} ${others === 1 ? t("other trainer searching") : t("other trainers searching")}`}
      </span>
    </p>
  );
}

/**
 * The ranked ladder, as a ladder.
 *
 * This replaced the line "Next tier in +116 → Silver". That sentence is
 * accurate and tells a player nothing they can feel: it names a number
 * without saying how far along they are, what comes after Silver, or that
 * there are five bands at all. Ranked's entire loop is climbing this, and it
 * was the smallest text on the card.
 *
 * Five segments, one per tier, each in its own tier colour. The band you are
 * in fills to your position within it; the ones behind you are solid, the
 * ones ahead are ghosted. So "how far up am I, and how much further" is
 * answered by shape before anything is read.
 */
export function TierTrack({ rating, unranked }: { rating: number; unranked: boolean }) {
  const t = useT();
  const here = tierFor(rating);
  const idx = PVP_TIERS.indexOf(here);
  const next = ratingToNextTier(rating);

  // How full the band you are standing in should LOOK.
  //
  // Not tierProgress(), and this is the whole reason the bar needed its own
  // number. Bronze spans 0–1100 and every account starts at 1000, so the
  // true band position of a player who has never battled is 91% — a bar
  // that reads "nearly promoted" for somebody who has done nothing, and
  // then asks them for another 100 points. The band below the starting
  // rating is only reachable by losing, so it is not progress anybody made.
  //
  // Measured from the START of the band you could actually be in: 1000 for
  // Bronze, the tier floor for everything above it. A fresh account reads
  // empty, 1050 reads half, and 984 — the rating in production that got
  // there by forfeiting — reads empty rather than 89%.
  const STARTING_RATING = 1000;
  const from = Math.max(here.floor, idx === 0 ? STARTING_RATING : here.floor);
  const span = Math.max(1, here.ceil - from);
  const within = Math.max(0, Math.min(1, (rating - from) / span));

  return (
    <div className="pvp-track" role="img"
      aria-label={unranked
        ? t("Unranked — play a ranked match to place")
        : `${here.name}${next ? ` · ${next.gap} ${t("to")} ${next.next.name}` : ` · ${t("top tier")}`}`}>
      <div className="pvp-track-bands">
        {PVP_TIERS.map((tier, i) => {
          const state = i < idx ? "done" : i === idx ? "here" : "ahead";
          return (
            <span key={tier.id} className={`pvp-track-band is-${state}`} title={tier.name}>
              <span
                className="pvp-track-fill"
                style={{
                  // Behind you: full. Ahead: empty. Here: how far in.
                  width: state === "done" ? "100%" : state === "here" && !unranked ? `${Math.round(within * 100)}%` : "0%",
                  background: tier.color,
                }}
              />
            </span>
          );
        })}
      </div>
      <div className="pvp-track-legend">
        <span className="pvp-track-now" style={{ color: here.color }}>
          {unranked ? t("Unranked") : here.name}
        </span>
        {next
          ? (
            <span className="pvp-track-next">
              <strong>{next.gap}</strong> {t("to")} {next.next.name}
            </span>
          )
          : <span className="pvp-track-next">{t("Top tier")}</span>}
      </div>
    </div>
  );
}

function ReadyUpSlab({
  inBattle, inQueue, noTeam, mode, stake, onReady, onCancel,
}: {
  inBattle: boolean;
  inQueue:  boolean;
  noTeam:   boolean;
  mode: Mode;
  /** Rating swing an even ranked game is worth, or null when nothing is at
   *  stake (casual, practice, or a provisional rating). */
  stake: number | null;
  onReady:  () => void;
  onCancel: () => void;
}) {
  const t = useT();
  if (noTeam) {
    return (
      <button className="pvp-slab pvp-slab-warn" onClick={() => { closePvpHub(); openTeamBuilder({ mode: "queue", levelCap: 50, onConfirm: () => { /* user closes */ } }); }}>
        <span className="pvp-slab-title">{t("BUILD A TEAM FIRST")}</span>
        <span className="pvp-slab-sub">{t("You need at least one Pokémon")}</span>
      </button>
    );
  }
  if (inBattle) {
    return (
      <button className="pvp-slab pvp-slab-live" disabled>
        <span className="pvp-slab-dot" />
        <span className="pvp-slab-title">{t("IN BATTLE")}</span>
        <span className="pvp-slab-sub">{t("Return to your battle modal")}</span>
      </button>
    );
  }
  if (inQueue) {
    return (
      <button className="pvp-slab pvp-slab-queued" onClick={onCancel}>
        <span className="pvp-slab-title">{t("STAND DOWN")}</span>
        <span className="pvp-slab-sub">{t("Cancel queue")}</span>
      </button>
    );
  }
  if (mode === "tournament") {
    return (
      <button className="pvp-slab pvp-slab-secondary" disabled>
        <span className="pvp-slab-title">{t("PICK A TOURNAMENT")}</span>
        <span className="pvp-slab-sub">{t("Open the tournament list below")}</span>
      </button>
    );
  }
  // The permanent door to the AI, next to the real modes rather than hidden
  // behind a 20-second wait. Someone playing at 3 a.m. already knows the queue
  // is empty and should not have to prove it first — but the offer stays a
  // deliberate choice, so RANKED remains the default chip.
  if (mode === "practice") {
    return (
      <div className="pvp-slab-wrap">
        <button className="pvp-slab pvp-slab-secondary" onClick={onReady}>
          <span className="pvp-slab-title">{t("PRACTICE VS AI")}</span>
          <span className="pvp-slab-sub">{t("Not rated · fair fight, picked for you")}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="pvp-slab-wrap">
      <button className="pvp-slab" onClick={onReady}>
        <span className="pvp-slab-title">{t("READY UP")}</span>
        <span className="pvp-slab-sub">{t("Ranked · Lv 50")}</span>
      </button>
      {/* What the button is worth. A ranked button that does not say what is
          at stake asks the player to press it on faith — and the swing is the
          one number their own rating will move by, so it is also the number
          that makes a loss legible afterwards. */}
      {stake != null && (
        <p className="pvp-stake">
          <span className="pvp-stake-win">+{stake}</span>
          <span className="dim">{t("if you win")}</span>
          <span className="pvp-stake-sep" aria-hidden>·</span>
          <span className="pvp-stake-loss">−{stake}</span>
          <span className="dim">{t("if you lose")}</span>
        </p>
      )}
    </div>
  );
}

// ─── Tournaments ───────────────────────────────────
// Sign-up existed; the bracket did not. A player could join an event and
// then had no way to learn who they were drawn against, when they had to
// play by, or whether they were still in — the bracket JSON was already
// in the list payload and simply never rendered.
//
// That matters more here than it would in a same-evening bracket. The
// event is asynchronous (see server/src/lib/tournamentRunner.ts): your
// match starts by itself the moment you and your opponent are both
// online inside the round window, and if the window closes without a
// battle it is awarded to whoever turned up. "Who am I playing and by
// when" is therefore the single thing a participant needs, and it is
// what the card leads with.

function TournamentList({ list, onChange }: { list: PublicTournament[]; onChange: (l: PublicTournament[]) => void }) {
  const { me } = useAuth();
  const t = useT();
  const [acting, setActing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = () => {
    api.listTournaments()
      .then((d) => onChange(d.tournaments))
      .catch((e) => setMsg(e?.message ?? t("Couldn't reload.")));
  };
  const join = async (id: string) => {
    setActing(id); setMsg(null);
    try { await api.joinTournament(id); setMsg(t("Joined.")); reload(); }
    catch (e: any) { setMsg(e?.message ?? t("Couldn't join.")); }
    finally { setActing(null); }
  };
  const leave = async (id: string) => {
    setActing(id); setMsg(null);
    try { await api.leaveTournament(id); setMsg(t("Withdrew.")); reload(); }
    catch (e: any) { setMsg(e?.message ?? t("Couldn't leave.")); }
    finally { setActing(null); }
  };

  if (list.length === 0) {
    return <p className="dim small" style={{ padding: "12px 16px" }}>{t("No tournaments scheduled right now.")}</p>;
  }
  return (
    <ul className="pvp-tour-list">
      {list.map((row) => {
        const joined = !!me && row.entries.some((e) => e.userId === me.id);
        const isOpen = row.status === "open";
        const bracket = row.bracket ? safeParseBracket(row.bracket) : null;
        const mySeed = me ? row.entries.find((e) => e.userId === me.id)?.seed ?? null : null;
        const standing = bracket && me ? myStanding(bracket, me.id) : null;
        const showBracket = expanded === row.id;
        return (
          <li key={row.id} className="pvp-tour-row">
            <div className="pvp-tour-row-info">
              <strong>{row.name}</strong>
              <span className="dim small">
                {row.status.toUpperCase()} · {row.entries.length} {t("entries")}
                {row.levelCap != null && ` · Lv ${row.levelCap}`}
                {mySeed != null && ` · ${t("your seed")} #${mySeed}`}
              </span>
              {standing && <TourStanding standing={standing} />}
            </div>
            <div className="pvp-tour-row-actions">
              {bracket && (
                <button
                  className="g-btn-ghost g-btn-small"
                  onClick={() => setExpanded(showBracket ? null : row.id)}
                >
                  {showBracket ? t("Hide bracket") : t("Bracket")}
                </button>
              )}
              {joined ? (
                <button className="g-btn-ghost g-btn-small" disabled={acting === row.id || !isOpen} onClick={() => leave(row.id)}>
                  {acting === row.id ? "…" : t("Withdraw")}
                </button>
              ) : (
                <button className="g-btn-primary g-btn-small" disabled={acting === row.id || !isOpen} onClick={() => join(row.id)}>
                  {acting === row.id ? "…" : t("Join")}
                </button>
              )}
            </div>
            {showBracket && bracket && (
              <BracketView bracket={bracket} meId={me?.id ?? null} />
            )}
          </li>
        );
      })}
      {msg && <li className="dim small pvp-tour-msg">{msg}</li>}
    </ul>
  );
}

/** The one line a participant actually needs: who, by when, or why not. */
function TourStanding({ standing }: { standing: Standing }) {
  const t = useT();
  if (standing.kind === "champion") {
    return <span className="pvp-tour-standing win">{t("You won the whole thing.")}</span>;
  }
  if (standing.kind === "out") {
    return (
      <span className="pvp-tour-standing out">
        {t("Knocked out")}{standing.by ? ` · ${standing.by}` : ""}
      </span>
    );
  }
  if (standing.kind === "waiting") {
    return <span className="pvp-tour-standing">{t("Through to the next round — waiting on your opponent.")}</span>;
  }
  return (
    <span className="pvp-tour-standing next">
      {standing.live
        ? `${t("Battle in progress vs")} ${standing.opponent}`
        : `${t("Next up: vs")} ${standing.opponent}`}
      {standing.deadlineAt != null && ` · ${deadlineLabel(standing.deadlineAt, t)}`}
      {!standing.live && ` · ${t("starts automatically when you are both online")}`}
    </span>
  );
}

function BracketView({ bracket, meId }: { bracket: PubBracket; meId: string | null }) {
  const t = useT();
  return (
    <div className="pvp-bracket">
      {bracket.rounds.map((round) => (
        <div className="pvp-bracket-round" key={round.index}>
          <header>{roundName(round.index, bracket.rounds.length, t)}</header>
          {round.matches.map((m) => {
            const mine = meId != null && (slotId(m.a) === meId || slotId(m.b) === meId);
            return (
              <div key={m.id} className={`pvp-bracket-match ${mine ? "mine" : ""} ${m.winnerId ? "done" : ""}`}>
                <span className={`pvp-bracket-slot ${m.winnerId && slotId(m.a) === m.winnerId ? "won" : ""}`}>
                  {slotLabel(m.a, t)}
                </span>
                <span className={`pvp-bracket-slot ${m.winnerId && slotId(m.b) === m.winnerId ? "won" : ""}`}>
                  {slotLabel(m.b, t)}
                </span>
                {m.winBy && m.winBy !== "battle" && (
                  <span className="pvp-bracket-by dim small">{t(winByLabel(m.winBy))}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Bracket shape (mirror of server/src/lib/bracket.ts) ──────
type PubSlot =
  | { kind: "player"; userId: string; username: string; seed?: number | null }
  | { kind: "bye" }
  | { kind: "winnerOf"; matchId: string }
  | { kind: "tbd" };
interface PubMatch {
  id: string;
  a: PubSlot;
  b: PubSlot;
  battleId?: string | null;
  winnerId?: string | null;
  winBy?: string | null;
  deadlineAt?: number | null;
}
interface PubBracket { rounds: { index: number; matches: PubMatch[] }[] }

type Standing =
  | { kind: "next"; opponent: string; deadlineAt: number | null; live: boolean }
  | { kind: "waiting" }
  | { kind: "out"; by: string | null }
  | { kind: "champion" };

function safeParseBracket(raw: string): PubBracket | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && Array.isArray(v.rounds)) return v as PubBracket;
  } catch { /* bracket is operator-written JSON; never trust it */ }
  return null;
}

function slotId(s: PubSlot): string | null {
  return s.kind === "player" ? s.userId : null;
}

function slotLabel(s: PubSlot, t: (v: string) => string): string {
  if (s.kind === "player") return s.seed ? `#${s.seed} ${s.username || "?"}` : (s.username || "?");
  if (s.kind === "bye") return t("(bye)");
  return t("TBD");
}

function winByLabel(by: string): string {
  if (by === "bye") return "bye";
  if (by === "walkover") return "walkover — opponent no-show";
  if (by === "forfeit") return "forfeit";
  if (by === "admin") return "awarded by an organiser";
  return by;
}

function roundName(index: number, total: number, t: (v: string) => string): string {
  const fromEnd = total - 1 - index;
  if (fromEnd === 0) return t("Final");
  if (fromEnd === 1) return t("Semi-finals");
  if (fromEnd === 2) return t("Quarter-finals");
  return `${t("Round")} ${index + 1}`;
}

/** Where this player stands. Walks the bracket forward: the first
 *  unresolved match they are in is their next one; a resolved match they
 *  lost is where they went out; surviving with no next match yet means
 *  the other half of their next pairing hasn't been decided. */
function myStanding(bracket: PubBracket, meId: string): Standing | null {
  let seen = false;
  for (const round of bracket.rounds) {
    for (const m of round.matches) {
      const aId = slotId(m.a);
      const bId = slotId(m.b);
      if (aId !== meId && bId !== meId) continue;
      seen = true;
      if (!m.winnerId) {
        const oppSlot = aId === meId ? m.b : m.a;
        return {
          kind: "next",
          opponent: oppSlot.kind === "player" ? (oppSlot.username || "?") : t0(oppSlot),
          deadlineAt: m.deadlineAt ?? null,
          live: !!m.battleId,
        };
      }
      if (m.winnerId !== meId) {
        return { kind: "out", by: m.winBy && m.winBy !== "battle" ? winByLabel(m.winBy) : null };
      }
      // Won it — keep walking; a later round may hold the next match.
    }
  }
  if (!seen) return null;
  const final = bracket.rounds[bracket.rounds.length - 1]?.matches[0];
  if (final?.winnerId === meId) return { kind: "champion" };
  return { kind: "waiting" };
}

function t0(s: PubSlot): string {
  return s.kind === "bye" ? "(bye)" : "TBD";
}

/** "play within 3h" / "today" / "overdue". Deliberately relative — an
 *  absolute timestamp in the player's locale is one more thing to get
 *  wrong across timezones, and what they need to know is how long they
 *  have got. */
function deadlineLabel(deadlineAt: number, t: (v: string) => string): string {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) return t("deadline passed");
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${t("play within")} ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${t("play within")} ${hours}h`;
  return `${t("play within")} ${Math.round(hours / 24)}d`;
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
