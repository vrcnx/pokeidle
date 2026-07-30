import { useEffect, useMemo, useState } from "react";
import { api, type GiveawayStats, type PublicGiveaway } from "../net/api";
import { useModalEnter } from "../utils/animate";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import { useAuth } from "../auth/AuthContext";
import { PrizeChips } from "./PrizeChips";
import { countdown, relativeTime, type RelTime } from "../utils/giveawayRail";
import {
  useGiveaways,
  refreshGiveaways,
  markEnteredLocally,
  markWinsSeen,
} from "../utils/giveawayStore";
import "./giveaways.css";

// Player-facing giveaways.
//
// Design intent: this is a hype surface, not a form. A giveaway that looks
// like a settings page will not get entered. So — big prize readout, a live
// entry count (social proof: "33 trainers entered"), a single unmissable
// ENTER button, and results that stay up afterwards with the winners named,
// because seeing a real player win is what makes the next one feel worth
// entering.
//
// Three things changed here, and each is a specific complaint:
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
  const dialogRef = useModalEnter(".giveaway-card");
  const t = useT();

  const snap = useGiveaways();
  // Extra history pages, fetched on demand. Kept separate from the shared
  // snapshot so a background refresh of the live list never discards pages
  // the player has already asked for.
  const [extra, setExtra] = useState<PublicGiveaway[]>([]);
  const [moreState, setMoreState] = useState<"idle" | "loading" | "done">("idle");
  const [showFair, setShowFair] = useState(false);

  useEffect(() => {
    _open = (targetId) => { setOpen(true); setHighlightId(targetId ?? null); };
    return () => { _open = null; };
  }, []);

  // Opening is the acknowledgement: the rail's win pulse stops once the
  // player has actually looked. The row still says they won.
  useEffect(() => {
    if (!open) return;
    void refreshGiveaways();
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

  const canLoadMore = moreState !== "done" && (snap.hasMoreHistory || extra.length > 0);

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div
        ref={dialogRef}
        className="g-modal giveaway-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Giveaways")}
      >
        <header className="giveaway-head">
          <div>
            <span className="giveaway-eyebrow">{t("Free to enter")}</span>
            <h2>{t("Giveaways")}</h2>
            <StatsLine stats={snap.stats} />
          </div>
          <button className="g-modal-close" onClick={() => setOpen(false)} aria-label={t("Close")}>×</button>
        </header>

        <div className="giveaway-body">
          {snap.error && list == null && <p className="giveaway-err">{snap.error}</p>}
          {!list && !snap.error && <p className="dim">{t("Loading…")}</p>}

          {list && live.length === 0 && past.length === 0 && (
            <div className="giveaway-empty">
              <span className="giveaway-empty-icon">🎁</span>
              <strong>{t("No giveaways running right now")}</strong>
              <p className="dim small">
                {t("Check back soon — and keep an eye on global chat, that's where we announce them.")}
              </p>
            </div>
          )}

          {live.map((g) => (
            <LiveGiveawayCard
              key={g.id}
              g={g}
              busy={entering === g.id}
              onEnter={() => enter(g)}
              highlighted={g.id === highlightId}
            />
          ))}

          {/* Nothing live, but there IS a history. Say so plainly rather than
              showing an empty space above the archive — a returning player
              reading "12 held" needs to know they have not missed a live one
              that is hiding somewhere below. */}
          {list && live.length === 0 && past.length > 0 && (
            <p className="gw-draw-line">
              {t("Nothing running right now.")}{" "}
              <strong>{t("Here's what has already been given away.")}</strong>
            </p>
          )}

          {past.length > 0 && (
            <>
              <div className="gw-section">
                <h3>{t("Previous giveaways")}</h3>
                <button
                  type="button"
                  className="gw-fair-link"
                  onClick={() => setShowFair((v) => !v)}
                  aria-expanded={showFair}
                >
                  {t("How winners are picked")}
                </button>
              </div>
              {/* Standing, not buried in each row's <details>. A visible
                  history makes repeat winners visible too, and an argument
                  about that is much easier to have with the proof already on
                  screen than after somebody has started it in chat. */}
              {showFair && (
                <p className="gw-fair-note">
                  {t("Winners are picked by hashing a random draw seed against every entry and taking the lowest results — nobody, including us, can change the outcome after the seed is set. Each drawn giveaway below publishes its seed so the result can be checked.")}
                </p>
              )}
              <div className="gw-past">
                {past.map((g) => (
                  <HistoryRow key={g.id} g={g} highlighted={g.id === highlightId} />
                ))}
                {canLoadMore && (
                  <button
                    type="button"
                    className="gw-more"
                    onClick={loadMore}
                    disabled={moreState === "loading"}
                  >
                    {moreState === "loading" ? t("Loading…") : t("Show more")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The date a past giveaway is filed under. drawnAt and endsAt are both
 *  nullable in production; createdAt always exists. */
function historyTime(g: PublicGiveaway): number {
  const at = g.drawnAt ?? g.endsAt ?? g.createdAt;
  const n = new Date(at).getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * "12 giveaways · 68 prizes to 39 trainers · since 17 Jul · you: 8 entered,
 * 2 won."
 *
 * The single most load-bearing line in the dialog. The owner's ask was to
 * "show previous etc to a degree", and the reason to show history at all is
 * that a returning player can see the feature is real and recurring — one
 * line of totals does that faster than any number of archive rows.
 */
function StatsLine({ stats }: { stats: GiveawayStats | null }) {
  const t = useT();
  if (!stats || stats.total === 0) return null;
  return (
    <p className="gw-stats">
      <span><strong>{stats.total}</strong> {t("held")}</span>
      {stats.prizesAwarded > 0 && (
        <span>
          <strong>{stats.prizesAwarded}</strong>{t(" prizes to ")}
          <strong>{stats.distinctWinners}</strong>{t(" trainers")}
        </span>
      )}
      {stats.firstAt && <span>{t("since ")}{shortDate(stats.firstAt)}</span>}
      {stats.you.entered > 0 && (
        <span className="gw-stats-you">
          {t("you: ")}<strong>{stats.you.entered}</strong>{t(" entered")}
          {stats.you.won > 0 && <>, <strong>{stats.you.won}</strong>{t(" won")}</>}
        </span>
      )}
    </p>
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

function HistoryRow({ g, highlighted }: { g: PublicGiveaway; highlighted?: boolean }) {
  const t = useT();
  const { me } = useAuth();
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
                <li key={`${w}-${i}`} className={me?.username === w ? "is-you" : ""}>
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
