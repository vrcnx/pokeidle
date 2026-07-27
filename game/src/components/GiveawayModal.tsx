import { useEffect, useState } from "react";
import { api, type GiveawayPrize, type PublicGiveaway } from "../net/api";
import { useModalEnter } from "../utils/animate";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";

// Player-facing giveaways.
//
// Design intent: this is a hype surface, not a form. A giveaway that
// looks like a settings page will not get entered. So — big prize
// readout, a live entry count (social proof: "412 trainers entered"),
// a single unmissable ENTER button, and results that stay up
// afterwards with the winners named, because seeing a real player win
// is what makes the next one feel worth entering.

let _open: ((targetId?: string) => void) | null = null;
// targetId: scroll to and briefly highlight one specific giveaway card
// (e.g. from the "View Giveaway" button on a chat announcement) instead
// of just opening on an undifferentiated list — matters once more than
// one giveaway can be live at the same time.
export function openGiveaways(targetId?: string) { _open?.(targetId); }

export function GiveawayModal() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PublicGiveaway[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const dialogRef = useModalEnter(".giveaway-card");
  const t = useT();

  useEffect(() => {
    _open = (targetId) => { setOpen(true); setHighlightId(targetId ?? null); };
    return () => { _open = null; };
  }, []);

  // Once the list has loaded, scroll the targeted card into view. The
  // highlight itself is cleared after a few seconds — it's a "here it
  // is" cue, not a permanent state.
  useEffect(() => {
    if (!highlightId || !list) return;
    const el = document.getElementById(`giveaway-${highlightId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const load = () => {
    api.listGiveaways()
      .then((d) => { setList(d.giveaways); setErr(null); })
      .catch((e) => setErr(e?.message ?? t("Couldn't load giveaways.")));
  };
  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
      load();
    } catch (e: any) {
      // The server explains WHY (not open yet / closed / level gate),
      // and that reason is far more useful than a generic failure.
      pushToast({ kind: "warn", icon: "⚠", text: e?.details?.reason ?? e?.message ?? t("Couldn't enter.") });
    } finally {
      setEntering(null);
    }
  };

  const live = (list ?? []).filter((g) => g.status === "open");
  const past = (list ?? []).filter((g) => g.status !== "open");

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
          </div>
          <button className="g-modal-close" onClick={() => setOpen(false)} aria-label={t("Close")}>×</button>
        </header>

        <div className="giveaway-body">
          {err && <p className="giveaway-err">{err}</p>}
          {!list && !err && <p className="dim">{t("Loading…")}</p>}

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
            <GiveawayCard
              key={g.id}
              g={g}
              busy={entering === g.id}
              onEnter={() => enter(g)}
              highlighted={g.id === highlightId}
            />
          ))}

          {past.length > 0 && (
            <>
              <h3 className="giveaway-section-head">{t("Past giveaways")}</h3>
              {past.map((g) => (
                <GiveawayCard key={g.id} g={g} busy={false} onEnter={() => {}} highlighted={g.id === highlightId} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GiveawayCard({
  g, busy, onEnter, highlighted,
}: {
  g: PublicGiveaway;
  busy: boolean;
  onEnter: () => void;
  highlighted?: boolean;
}) {
  const t = useT();
  const isLive = g.status === "open";
  const drawn = g.status === "drawn";
  return (
    <article
      id={`giveaway-${g.id}`}
      className={`giveaway-card ${isLive ? "is-live" : ""} ${g.youWon ? "is-won" : ""} ${highlighted ? "is-highlighted" : ""}`}
    >
      {g.youWon && (
        <div className="giveaway-won-banner">
          <span>{t("🏆 You won this one!")}</span>
          <PrizeDeliveredNote prizes={g.prizes} />
        </div>
      )}

      <header className="giveaway-card-head">
        <div className="giveaway-card-title">
          <h3>{g.title}</h3>
          <span className={`giveaway-status giveaway-status--${g.status}`}>
            {isLive ? t("LIVE") : drawn ? t("DRAWN") : t("CLOSED")}
          </span>
        </div>
        {isLive && g.endsAt && (
          <Countdown to={g.endsAt} />
        )}
      </header>

      {g.description && <p className="giveaway-desc">{g.description}</p>}

      <div className="giveaway-prize">
        <span className="giveaway-prize-label">{t("Prize")}</span>
        <strong className="giveaway-prize-value">{g.prizeSummary}</strong>
        {g.winnerCount > 1 && (
          <span className="dim small">{g.winnerCount}{t(" winners")}</span>
        )}
      </div>

      <footer className="giveaway-card-foot">
        <span className="giveaway-entries dim small">
          <strong className="tabular">{g.entryCount.toLocaleString()}</strong>
          {" "}{t("trainer")}{g.entryCount === 1 ? "" : "s"}{t(" entered")}
        </span>

        {isLive && (
          g.hasEntered ? (
            <span className="giveaway-entered">{t("✓ Entered")}</span>
          ) : (
            <button className="giveaway-enter" onClick={onEnter} disabled={busy}>
              {busy ? "…" : t("Enter")}
            </button>
          )
        )}
      </footer>

      {/* Results stay up. Seeing a real player win is what makes the
          next giveaway feel worth entering. */}
      {drawn && g.winners.length > 0 && (
        <div className="giveaway-winners">
          <span className="giveaway-winners-label">{t("🎉 Winner")}{g.winners.length === 1 ? "" : "s"}</span>
          <span className="giveaway-winners-list">{g.winners.map((w) => `@${w}`).join(", ")}</span>
          {g.drawSeed && (
            <details className="giveaway-fair">
              <summary className="dim small">{t("Was this fair?")}</summary>
              <p className="dim small">
                {t("Winners are picked by hashing this draw seed against every entry and taking the lowest results — nobody, including us, can change the outcome after the seed is set. It's published here so the draw can be checked.")}
              </p>
              <code className="giveaway-seed">{g.drawSeed}</code>
            </details>
          )}
        </div>
      )}

      {isLive && g.minAccountLevel != null && (
        <p className="giveaway-gate dim small">{t("Account level ")}{g.minAccountLevel}{t("+ only")}</p>
      )}
    </article>
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
function PrizeDeliveredNote({ prizes }: { prizes: GiveawayPrize[] }) {
  const t = useT();
  const kinds = new Set((prizes ?? []).map((p) => p.kind));
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
    <span className="giveaway-won-note">
      {where}{" "}
      {t("If you can't see it yet, it arrives the next time your game saves.")}
    </span>
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
  const ms = new Date(to).getTime() - Date.now();
  if (ms <= 0) return <span className="giveaway-countdown ended">{t("Closing…")}</span>;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <span className={`giveaway-countdown ${ms < 3600000 ? "urgent" : ""}`}>
      {d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`}{t(" left")}
    </span>
  );
}
