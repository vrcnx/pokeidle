import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type GiveawayStats, type Promo, type PublicGiveaway } from "../net/api";
import { useModalEnter } from "../utils/animate";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import { useAuth } from "../auth/AuthContext";
import { PrizeChips } from "./PrizeChips";
import { PromoCard } from "./PromoCard";
import { countdown, relativeTime, type RelTime } from "../utils/giveawayRail";
import {
  useGiveaways,
  refreshGiveaways,
  refreshPromos,
  markEnteredLocally,
  markWinsSeen,
} from "../utils/giveawayStore";
import "./giveaways.css";

// Rewards — the one place in the game where free things live.
//
// ── WHY IT IS NOT "GIVEAWAYS" ANY MORE ──────────────────────────────
// The Discord link reward existed for months and no player could see it. It
// was configured in the admin dashboard, granted correctly on link, and
// entirely invisible from inside the game: the prize was revealed only AFTER
// somebody had already linked. Meanwhile this dialog was a single-purpose
// giveaway list. Two features, one of them unfindable, and no surface that
// answers the question a player actually has — "is there anything free right
// now?"
//
// So this is the answer to that question, and giveaways are one of its
// sections rather than its entire subject. Free rewards go first: they are
// guaranteed, they are always there, and they are what a first-time reader
// can act on immediately. Giveaways follow, because they are a lottery.
//
// ── THE TONE ────────────────────────────────────────────────────────
// This used to be built as "a hype surface, not a form" — an eyebrow reading
// FREE TO ENTER above a 21px heading, a 40px emoji when empty, gradient
// washes. That reads as a promotion for itself, and it is the wrong register
// for a screen whose actual job is to tell you plainly what you can have and
// what you have to do to get it. Quieter type, one accent, sections that
// declare themselves in a line of 10px caps, and the loudest things on screen
// are the prizes and the single button that gets you one.
//
// Three earlier fixes that still hold:
//
//   1. The prize was the server's `describePrizes()` string, so players were
//      being told they had won "1x goldbottlecap + 2x silverbottlecap". Every
//      one of those ids resolves in the item catalog and every Pokémon prize
//      already ships its whole mon — see utils/prizeDisplay.ts.
//   2. Live giveaways and history rendered through the SAME card component.
//      Twelve past giveaways got twelve hero cards, none of them dated, and
//      the one live giveaway was lost in the middle of them. History is now a
//      compact, dated, expandable row and lives under its own heading.
//   3. Opening it always cost a cold fetch and a "Loading…" flash. The rail
//      already holds a shared snapshot (utils/giveawayStore.ts), so the
//      dialog paints from it immediately and refreshes behind the paint.

let _open: ((targetId?: string) => void) | null = null;
// targetId: scroll to and briefly highlight one specific giveaway card
// (e.g. from the "View Giveaway" button on a chat announcement, or from the
// rail) instead of just opening on an undifferentiated list — matters once
// more than one giveaway can be live at the same time, which production does
// routinely (four were published in one burst).
export function openGiveaways(targetId?: string) { _open?.(targetId); }

export function GiveawayModal() {
  const [open, setOpen] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const t = useT();
  const { me } = useAuth();

  const snap = useGiveaways();
  // Extra history pages, fetched on demand. Kept separate from the shared
  // snapshot so a background refresh of the live list never discards pages
  // the player has already asked for.
  const [extra, setExtra] = useState<PublicGiveaway[]>([]);
  const [moreState, setMoreState] = useState<"idle" | "loading" | "done">("idle");

  useEffect(() => {
    _open = (targetId) => { setOpen(true); setHighlightId(targetId ?? null); };
    return () => { _open = null; };
  }, []);

  // Opening is the acknowledgement: the rail's win pulse stops once the
  // player has actually looked. The row still says they won.
  useEffect(() => {
    if (!open) return;
    void refreshGiveaways();
    // Opening is one of the three moments a promo can have changed under us —
    // the other two are the first load and coming back from Discord.
    void refreshPromos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-run on the snapshot, not only on open: a player who opens the dialog
  // during the very first fetch would otherwise acknowledge an empty list and
  // the rail would keep pulsing at a win they have already looked at.
  useEffect(() => {
    if (!open || !snap.giveaways) return;
    markWinsSeen(snap.giveaways.filter((g) => g.youWon).map((g) => g.id));
  }, [open, snap.giveaways]);

  // Once the list has content, scroll the targeted card into view. The
  // highlight itself is cleared after a few seconds — it's a "here it
  // is" cue, not a permanent state.
  useEffect(() => {
    if (!highlightId || !snap.giveaways) return;
    const el = document.getElementById(`giveaway-${highlightId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.giveaways, highlightId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const list = snap.giveaways;
  const live = useMemo(() => (list ?? []).filter((g) => g.status === "open"), [list]);
  // Merge the snapshot's history with any pages fetched since, newest first.
  // De-duped by id because /history can legitimately re-return a row that the
  // list route also carried.
  const past = useMemo(() => {
    const byId = new Map<string, PublicGiveaway>();
    for (const g of list ?? []) if (g.status !== "open") byId.set(g.id, g);
    for (const g of extra) byId.set(g.id, g);
    return [...byId.values()].sort(
      (a, b) => historyTime(b) - historyTime(a),
    );
  }, [list, extra]);

  // A collected promo stays on screen — it is a short list, and a card that
  // says "collected" is what stops a player hunting for a reward they have
  // already had. But it sorts below the ones they can still take.
  //
  // Above the `!open` return with the other memos, because hooks may not be
  // conditional.
  const sortedPromos = useMemo(
    () => [...(snap.promos ?? [])].sort((a, b) => rankPromo(a.state) - rankPromo(b.state)),
    [snap.promos],
  );

  if (!open) return null;

  const enter = async (g: PublicGiveaway) => {
    setEntering(g.id);
    try {
      const res = await api.enterGiveaway(g.id);
      pushToast({
        kind: "success",
        icon: "🎟",
        text: res.alreadyEntered ? t("You're already entered!") : `Entered — good luck!`,
      });
      // Flip the UI on the click, then let the refetch be the authority.
      markEnteredLocally(g.id, res.entryCount);
      void refreshGiveaways({ force: true });
    } catch (e: any) {
      // The server explains WHY (not open yet / closed / level gate),
      // and that reason is far more useful than a generic failure.
      pushToast({ kind: "warn", icon: "⚠", text: e?.details?.reason ?? e?.message ?? t("Couldn't enter.") });
    } finally {
      setEntering(null);
    }
  };

  const loadMore = async () => {
    setMoreState("loading");
    const oldest = past[past.length - 1];
    try {
      const res = await api.giveawayHistory(oldest ? oldest.createdAt : null, 20);
      setExtra((prev) => [...prev, ...res.giveaways]);
      setMoreState(res.hasMore ? "idle" : "done");
    } catch {
      setMoreState("idle");
      pushToast({ kind: "warn", icon: "⚠", text: t("Couldn't load more giveaways.") });
    }
  };

  return (
    <RewardsDialog
      promos={sortedPromos}
      live={live}
      past={past}
      stats={snap.stats}
      loading={list == null && !snap.error}
      error={list == null ? snap.error : null}
      highlightId={highlightId}
      entering={entering}
      onEnter={enter}
      canLoadMore={moreState !== "done" && (snap.hasMoreHistory || extra.length > 0)}
      moreState={moreState}
      onLoadMore={loadMore}
      viewerName={me?.username ?? null}
      onClose={() => setOpen(false)}
    />
  );
}

export interface RewardsDialogProps {
  promos: Promo[];
  live: PublicGiveaway[];
  past: PublicGiveaway[];
  stats: GiveawayStats | null;
  loading: boolean;
  error: string | null;
  highlightId: string | null;
  entering: string | null;
  onEnter: (g: PublicGiveaway) => void;
  canLoadMore: boolean;
  moreState: "idle" | "loading" | "done";
  onLoadMore: () => void;
  /** The viewer's own username, so their name is picked out of a winner
   *  list. A prop rather than a useAuth() call inside HistoryRow: the
   *  presentational half of this dialog must be mountable without the app's
   *  providers, which is the entire point of the split. */
  viewerName: string | null;
  onClose: () => void;
}

/**
 * The dialog itself, with no store, no socket and no network.
 *
 * Split out for the same reason WelcomeBackDialog was: reaching this screen in
 * a state worth looking at needs a signed-in session, a configured promotion,
 * a live giveaway AND an archive behind it — which is not a loop anyone can
 * iterate a layout in. rewards-preview.tsx mounts THIS component with the real
 * stylesheet, so what gets checked is the same JSX and the same CSS, with only
 * the data replaced.
 *
 * That is not a hypothetical benefit. A CSS syntax error shipped in this app
 * recently that voided every design token in the game, and neither `tsc` nor
 * 541 passing tests noticed, because neither of them reads CSS.
 */
export function RewardsDialog({
  promos, live, past, stats, loading, error,
  highlightId, entering, onEnter,
  canLoadMore, moreState, onLoadMore, viewerName, onClose,
}: RewardsDialogProps) {
  const t = useT();
  const dialogRef = useModalEnter(".rw-pane");
  const [showFair, setShowFair] = useState(false);
  // null = "whatever the data says is most worth looking at". It stops being
  // null the moment the player picks a tab, and never goes back — a dialog
  // that re-picks your tab under you on a background refresh is infuriating.
  const [picked, setPicked] = useState<TabId | null>(null);

  const freeOpen = promos.filter((p) => p.state === "available").length;
  const unentered = live.filter((g) => !g.hasEntered).length;

  // Free rewards is ALWAYS a tab, even at zero. It is the standing half of
  // this screen and the half a player has to know exists; the other two are
  // event-driven and simply absent when there are no events.
  const tabs: Tab[] = [
    { id: "free", icon: "✦", label: t("Free rewards"), badge: freeOpen || null, tone: "promo" },
    ...(live.length ? [{ id: "live" as const, icon: "🎟", label: t("Giveaways"), badge: unentered || null, tone: "live" as const }] : []),
    ...(past.length ? [{ id: "past" as const, icon: "🏆", label: t("Results"), badge: null, tone: "past" as const }] : []),
  ];

  // Land on the thing with something to DO, in the order it is worth doing:
  // a free reward nobody has collected, then a giveaway nobody has entered,
  // then whatever exists at all.
  const fallback: TabId =
    freeOpen > 0 ? "free"
    : unentered > 0 ? "live"
    : promos.length > 0 ? "free"
    : live.length > 0 ? "live"
    : past.length > 0 ? "past"
    : "free";
  // Guard against a tab that has disappeared since it was picked (the last
  // live giveaway drew while the dialog was open).
  const active = picked && tabs.some((x) => x.id === picked) ? picked : fallback;

  const body = loading
    ? <p className="dim">{t("Loading…")}</p>
    : error
    ? <p className="giveaway-err">{error}</p>
    : active === "free"
    ? <FreePane promos={promos} />
    : active === "live"
    ? (
      <div className="rw-list">
        {live.map((g) => (
          <LiveGiveawayCard
            key={g.id}
            g={g}
            busy={entering === g.id}
            onEnter={() => onEnter(g)}
            highlighted={g.id === highlightId}
          />
        ))}
      </div>
    )
    : (
      <>
        <div className="rw-pane-head">
          <p className="rw-pane-note">
            {t("Every giveaway that has already been drawn, and who won it.")}
          </p>
          <button
            type="button"
            className="gw-fair-link"
            onClick={() => setShowFair((v) => !v)}
            aria-expanded={showFair}
          >
            {t("How winners are picked")}
          </button>
        </div>
        {/* Standing, not buried in each row's <details>. A visible history
            makes repeat winners visible too, and an argument about that is
            much easier to have with the proof already on screen than after
            somebody has started it in chat. */}
        {showFair && (
          <p className="gw-fair-note">
            {t("Winners are picked by hashing a random draw seed against every entry and taking the lowest results — nobody, including us, can change the outcome after the seed is set. Each drawn giveaway below publishes its seed so the result can be checked.")}
          </p>
        )}
        <div className="gw-past">
          {past.map((g) => (
            <HistoryRow key={g.id} g={g} highlighted={g.id === highlightId} viewerName={viewerName} />
          ))}
          {canLoadMore && (
            <button
              type="button"
              className="gw-more"
              onClick={onLoadMore}
              disabled={moreState === "loading"}
            >
              {moreState === "loading" ? t("Loading…") : t("Show more")}
            </button>
          )}
        </div>
      </>
    );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal giveaway-modal rewards-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Rewards")}
      >
        <header className="giveaway-head">
          <div className="gw-head-main">
            <h2>{t("Rewards")}</h2>
            <p className="gw-head-sub">
              {t("Everything you can get for free — no purchase, ever.")}
            </p>
          </div>
          <button className="g-modal-close" onClick={onClose} aria-label={t("Close")}>×</button>
        </header>

        <div className="rw-shell">
          <aside className="rw-side">
            <nav className="rw-nav" role="tablist" aria-label={t("Rewards")}>
              {tabs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="tab"
                  aria-selected={active === x.id}
                  className={`rw-tab rw-tab--${x.tone}${active === x.id ? " is-active" : ""}`}
                  onClick={() => setPicked(x.id)}
                >
                  <span className="rw-tab-icon" aria-hidden>{x.icon}</span>
                  <span className="rw-tab-label">{x.label}</span>
                  {/* The badge counts what is ACTIONABLE, not what exists.
                      "3" next to Giveaways meaning "three you have already
                      entered" is the kind of number that trains people to
                      stop reading badges. */}
                  {x.badge != null && <span className="rw-tab-badge">{x.badge}</span>}
                </button>
              ))}
            </nav>

            <HaulPanel stats={stats} />
          </aside>

          <div className="rw-pane" role="tabpanel">{body}</div>
        </div>
      </div>
    </div>
  );
}

type TabId = "free" | "live" | "past";
interface Tab {
  id: TabId;
  icon: string;
  label: string;
  /** Things to act on. Null renders no badge at all — a grey zero is noise. */
  badge: number | null;
  tone: "promo" | "live" | "past";
}

/**
 * The free-rewards pane, with its own progress readout.
 *
 * "1 of 2 collected" with a bar is the one honestly gamified thing on this
 * screen: it is a real, finite, completable set, which is exactly the shape a
 * progress bar is allowed to describe. Giveaways get no bar, because you
 * cannot complete a lottery.
 */
function FreePane({ promos }: { promos: Promo[] }) {
  const t = useT();
  if (promos.length === 0) {
    return (
      <div className="gw-empty">
        <strong>{t("Nothing free right now")}</strong>
        <p>{t("Free rewards are things you keep for good — join the Discord, hit a milestone. When one is running it shows up here, and we announce it in global chat.")}</p>
      </div>
    );
  }
  const done = promos.filter((p) => p.state === "claimed").length;
  return (
    <>
      <div className="rw-pane-head">
        <p className="rw-pane-note">{t("Do the thing, keep the prize. No draw, no entry.")}</p>
        <span className="rw-progress">
          <span className="rw-progress-text">
            <strong>{done}</strong>/{promos.length} {t("collected")}
          </span>
          <span className="rw-progress-bar">
            <span
              className="rw-progress-fill"
              style={{ width: `${Math.round((done / promos.length) * 100)}%` }}
            />
          </span>
        </span>
      </div>
      <div className="rw-list">
        {promos.map((p) => <PromoCard key={p.id} promo={p} />)}
      </div>
    </>
  );
}

/** Available first, then locked (still worth doing), then collected. */
function rankPromo(state: string): number {
  return state === "available" ? 0 : state === "locked" ? 1 : 2;
}

/** The date a past giveaway is filed under. drawnAt and endsAt are both
 *  nullable in production; createdAt always exists. */
function historyTime(g: PublicGiveaway): number {
  const at = g.drawnAt ?? g.endsAt ?? g.createdAt;
  const n = new Date(at).getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * The bottom of the sidebar: the player's own record, then the feature's.
 *
 * This used to be one grey line of totals — "13 held · 68 prizes to 39
 * trainers · since 17 Jul · you: 8 entered, 2 won" — with the player's own
 * numbers as the fourth clause of a sentence about somebody else. Their two
 * numbers are the interesting ones and now they are the big ones, which is
 * the whole difference between reporting a statistic and showing somebody
 * their record.
 *
 * The global totals stay, underneath and small. They are still doing real
 * work: a returning player who missed the last three giveaways needs to see
 * that there WERE three, and no number of archive rows says that as fast.
 */
function HaulPanel({ stats }: { stats: GiveawayStats | null }) {
  const t = useT();
  if (!stats || stats.total === 0) return null;
  return (
    <div className="rw-haul">
      <span className="rw-haul-head">{t("Your record")}</span>
      <div className="rw-haul-figures">
        <span className={`rw-figure${stats.you.won > 0 ? " is-gold" : ""}`}>
          <strong>{stats.you.won}</strong>
          <em>{stats.you.won === 1 ? t("win") : t("wins")}</em>
        </span>
        <span className="rw-figure">
          <strong>{stats.you.entered}</strong>
          <em>{stats.you.entered === 1 ? t("entry") : t("entries")}</em>
        </span>
      </div>
      <p className="rw-haul-global">
        <span><strong>{stats.total}</strong> {t("giveaways held")}</span>
        {stats.prizesAwarded > 0 && (
          <span>
            <strong>{stats.prizesAwarded}</strong>{t(" prizes to ")}
            <strong>{stats.distinctWinners}</strong>{t(" trainers")}
          </span>
        )}
        {stats.firstAt && <span>{t("since ")}{shortDate(stats.firstAt)}</span>}
      </p>
    </div>
  );
}

// ── Live card ───────────────────────────────────────────────────────
// Keeps the existing .giveaway-card chrome; what is new is the prize (chips
// instead of an id string), an explicit draw time, and a delivery state that
// is read from the server rather than guessed.
function LiveGiveawayCard({
  g, busy, onEnter, highlighted,
}: {
  g: PublicGiveaway;
  busy: boolean;
  onEnter: () => void;
  highlighted?: boolean;
}) {
  const t = useT();
  return (
    <article
      id={`giveaway-${g.id}`}
      className={`giveaway-card is-live ${g.youWon ? "is-won" : ""} ${highlighted ? "is-highlighted" : ""}`}
    >
      <header className="giveaway-card-head">
        <div className="giveaway-card-title">
          <h3>{g.title}</h3>
          <span className="giveaway-status giveaway-status--open">{t("LIVE")}</span>
        </div>
        {g.endsAt && <Countdown to={g.endsAt} />}
      </header>

      {g.description && <p className="giveaway-desc">{g.description}</p>}

      <div className="gw-live-prize">
        <span className="gw-live-prize-head">
          <span>{t("Prize")}</span>
          {g.winnerCount > 1 && <span>{g.winnerCount}{t(" winners, one prize each")}</span>}
        </span>
        <PrizeChips prizes={g.prizes} />
      </div>

      <p className="gw-draw-line">
        {g.endsAt
          ? <>{t("Draws ")}<strong>{longDate(g.endsAt)}</strong>{t(", right after entries close.")}</>
          : t("Draws when the operator closes it — no fixed date, so enter now.")}
      </p>

      <footer className="giveaway-card-foot">
        <span className="giveaway-entries dim small">
          <strong className="tabular">{g.entryCount.toLocaleString()}</strong>
          {" "}{t("trainer")}{g.entryCount === 1 ? "" : "s"}{t(" entered")}
        </span>

        {g.hasEntered ? (
          <span className="giveaway-entered">{t("✓ Entered")}</span>
        ) : (
          <button className="giveaway-enter" onClick={onEnter} disabled={busy}>
            {busy ? "…" : t("Enter")}
          </button>
        )}
      </footer>

      {g.minAccountLevel != null && (
        <p className="giveaway-gate dim small">{t("Account level ")}{g.minAccountLevel}{t("+ only")}</p>
      )}
    </article>
  );
}

// ── History row ─────────────────────────────────────────────────────
// Compact and dated by default; the whole row expands into the detail. Twelve
// past giveaways rendered as twelve hero cards is what "show previous" turns
// into if the two layouts are not separated.
const WINNERS_INLINE = 3;

function HistoryRow({ g, highlighted, viewerName }: { g: PublicGiveaway; highlighted?: boolean; viewerName: string | null }) {
  const t = useT();
  const [expanded, setExpanded] = useState(!!highlighted);
  useEffect(() => { if (highlighted) setExpanded(true); }, [highlighted]);

  const when = historyTime(g);
  const rel = relativeTime(when, Date.now());
  const shown = g.winners.slice(0, WINNERS_INLINE);
  const hidden = Math.max(0, g.winners.length - shown.length);

  return (
    <>
      <button
        type="button"
        id={`giveaway-${g.id}`}
        className={`gw-past-row${g.youWon ? " is-won" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="gw-past-date">{relText(rel, when, t)}</span>
        <span className="gw-past-main">
          <span className="gw-past-title">{g.title}</span>
          <PrizeChips prizes={g.prizes} size="sm" />
        </span>
        <span className="gw-past-right">
          {g.youWon && <span className="gw-past-youwon">{t("YOU WON")}</span>}
          <span className="gw-past-winners">
            {g.winners.length === 0 ? t("not drawn") : `@${shown.join(", @")}`}
          </span>
          {/* Outside the ellipsising span on purpose. Three long usernames
              overflow 190px (measured: "@dudsdiem, @dwellbreathe,
              @lilkidkolaps63"), and if "+9" is inside that span it is the
              first thing the ellipsis eats — losing the one number that says
              how many winners there actually were.

              "+9 more", not a bare "+9": the noun it counts is only obvious
              from what sits to its left, and the rail's prize line used to
              print "+1" a few pixels away meaning one more PRIZE. The prize
              line now says "& 1 more" (see prizeDisplay.primaryPrizeLabel),
              so `+` counts winners and nothing else — and the title spells
              out the total for anyone the shorthand still loses. */}
          {hidden > 0 && (
            <span
              className="gw-past-more"
              title={`${g.winners.length}${t(" winners in total")}`}
            >
              +{hidden}{t(" more")}
            </span>
          )}
          <span className="gw-past-caret" aria-hidden>{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div className="gw-past-detail">
          {g.description && <p className="gw-past-desc">{g.description}</p>}
          <p className="gw-past-meta">
            <span><strong>{g.entryCount.toLocaleString()}</strong>{t(" entered")}</span>
            <span><strong>{g.winnerCount}</strong>{t(" won")}</span>
            {g.drawnAt && <span>{t("drawn ")}{longDate(g.drawnAt)}</span>}
            {g.hasEntered && !g.youWon && <span>{t("you entered this one")}</span>}
          </p>

          {g.winners.length > 0 && (
            <ul className="gw-winner-list">
              {g.winners.map((w, i) => (
                // Twelve winners is a real production value; the list is the
                // full one here, and the viewer's own name is picked out so
                // they don't have to scan for it.
                <li key={`${w}-${i}`} className={viewerName === w ? "is-you" : ""}>
                  @{w}
                </li>
              ))}
            </ul>
          )}

          {g.youWon && <PrizeDeliveredNote g={g} />}

          {g.drawSeed && (
            <details className="giveaway-fair">
              <summary className="dim small">{t("Check this draw")}</summary>
              <p className="dim small">
                {t("Winners are picked by hashing this draw seed against every entry id and taking the lowest results. The seed is generated at draw time and stored, so the outcome cannot be changed afterwards — it's published here so anyone can recompute it.")}
              </p>
              <code className="giveaway-seed">{g.drawSeed}</code>
            </details>
          )}
        </div>
      )}
    </>
  );
}

// "Where is my prize?"
//
// There has never been a Receive button — prizes are granted server-side and
// land in the save by themselves — but the won banner only ever said "You won
// this one!", so players concluded there must be a claim step somewhere and
// started telling each other to look for it under settings → view giveaways →
// "Receive". This says plainly that it is automatic, and names the place the
// prize actually shows up.
//
// Split by prize kind because "check your Bag" is actively wrong for money and
// for a Pokémon, and being wrong here is what started the hunt in the first
// place. Whole sentences per case rather than assembled fragments, so
// translators get real sentences to work with.
//
// `youWonDelivered` now comes from the server (the winner's own PendingGrant
// row, nobody else's), so the "if you can't see it yet" line is only shown
// when it is TRUE. Three real winners are sitting on an undelivered prize as
// this ships and one of them waited 36 hours; guessing on their behalf is what
// this used to do.
function PrizeDeliveredNote({ g }: { g: PublicGiveaway }) {
  const t = useT();
  const kinds = new Set((g.prizes ?? []).map((p) => p.kind));
  const only = kinds.size === 1 ? [...kinds][0] : null;
  const where =
    only === "money"
      ? t("Your prize was added to your money automatically — there is nothing to claim.")
      : only === "pokemon"
      ? t("Your prize was sent to your Box automatically — there is nothing to claim.")
      : only === "item"
      ? t("Your prize was added to your Bag automatically — there is nothing to claim.")
      : t("Your prizes were added to your account automatically — there is nothing to claim.");
  return (
    <div className="gw-won-note">
      <span className="gw-won-note-head">{t("🏆 You won this one!")}</span>
      <span className="gw-won-note-body">
        {where}{" "}
        {g.youWonDelivered === true
          ? t("It has already been delivered.")
          : g.youWonDelivered === false
          ? t("It is queued and arrives the next time your game saves.")
          : t("If you can't see it yet, it arrives the next time your game saves.")}
      </span>
    </div>
  );
}

// Live countdown. Re-renders each second while a giveaway is closing —
// a deadline you can watch is a deadline you act on.
function Countdown({ to }: { to: string }) {
  const [, force] = useState(0);
  const t = useT();
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const c = countdown(new Date(to).getTime() - Date.now());
  if (c.ended) return <span className="giveaway-countdown ended">{t("Closing…")}</span>;
  return (
    <span className={`giveaway-countdown ${c.urgent ? "urgent" : ""}`}>
      {c.d > 0 ? `${c.d}d ${c.h}h` : c.h > 0 ? `${c.h}h ${c.m}m` : `${c.m}m ${c.s}s`}{t(" left")}
    </span>
  );
}

// ── Dates ───────────────────────────────────────────────────────────
// The relative arithmetic is pure and lives in utils/giveawayRail.ts (and is
// tested there); only the fallback to an absolute date is locale-dependent,
// so only that part touches toLocaleDateString.
function relText(rel: RelTime, at: number, t: (s: string) => string): string {
  switch (rel.unit) {
    case "now":  return t("just now");
    case "min":  return `${rel.value}${t("m ago")}`;
    case "hour": return `${rel.value}${t("h ago")}`;
    case "day":  return `${rel.value}${t("d ago")}`;
    default:     return shortDate(new Date(at).toISOString());
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function longDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}
