import { useEffect, useState } from "react";
import { api, type PublicGiveaway } from "../net/api";
import { useModalEnter } from "../utils/animate";
import { pushToast } from "./Toast";

// Player-facing giveaways.
//
// Design intent: this is a hype surface, not a form. A giveaway that
// looks like a settings page will not get entered. So — big prize
// readout, a live entry count (social proof: "412 trainers entered"),
// a single unmissable ENTER button, and results that stay up
// afterwards with the winners named, because seeing a real player win
// is what makes the next one feel worth entering.

let _open: (() => void) | null = null;
export function openGiveaways() { _open?.(); }

export function GiveawayModal() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PublicGiveaway[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const dialogRef = useModalEnter(".giveaway-card");

  useEffect(() => {
    _open = () => setOpen(true);
    return () => { _open = null; };
  }, []);

  const load = () => {
    api.listGiveaways()
      .then((d) => { setList(d.giveaways); setErr(null); })
      .catch((e) => setErr(e?.message ?? "Couldn't load giveaways."));
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
        text: res.alreadyEntered ? "You're already entered!" : `Entered — good luck!`,
      });
      load();
    } catch (e: any) {
      // The server explains WHY (not open yet / closed / level gate),
      // and that reason is far more useful than a generic failure.
      pushToast({ kind: "warn", icon: "⚠", text: e?.details?.reason ?? e?.message ?? "Couldn't enter." });
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
        aria-label="Giveaways"
      >
        <header className="giveaway-head">
          <div>
            <span className="giveaway-eyebrow">Free to enter</span>
            <h2>Giveaways</h2>
          </div>
          <button className="g-modal-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
        </header>

        <div className="giveaway-body">
          {err && <p className="giveaway-err">{err}</p>}
          {!list && !err && <p className="dim">Loading…</p>}

          {list && live.length === 0 && past.length === 0 && (
            <div className="giveaway-empty">
              <span className="giveaway-empty-icon">🎁</span>
              <strong>No giveaways running right now</strong>
              <p className="dim small">
                Check back soon — and keep an eye on global chat, that's where
                we announce them.
              </p>
            </div>
          )}

          {live.map((g) => (
            <GiveawayCard
              key={g.id}
              g={g}
              busy={entering === g.id}
              onEnter={() => enter(g)}
            />
          ))}

          {past.length > 0 && (
            <>
              <h3 className="giveaway-section-head">Past giveaways</h3>
              {past.map((g) => <GiveawayCard key={g.id} g={g} busy={false} onEnter={() => {}} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GiveawayCard({
  g, busy, onEnter,
}: {
  g: PublicGiveaway;
  busy: boolean;
  onEnter: () => void;
}) {
  const isLive = g.status === "open";
  const drawn = g.status === "drawn";
  return (
    <article className={`giveaway-card ${isLive ? "is-live" : ""} ${g.youWon ? "is-won" : ""}`}>
      {g.youWon && <div className="giveaway-won-banner">🏆 You won this one!</div>}

      <header className="giveaway-card-head">
        <div className="giveaway-card-title">
          <h3>{g.title}</h3>
          <span className={`giveaway-status giveaway-status--${g.status}`}>
            {isLive ? "LIVE" : drawn ? "DRAWN" : "CLOSED"}
          </span>
        </div>
        {isLive && g.endsAt && (
          <Countdown to={g.endsAt} />
        )}
      </header>

      {g.description && <p className="giveaway-desc">{g.description}</p>}

      <div className="giveaway-prize">
        <span className="giveaway-prize-label">Prize</span>
        <strong className="giveaway-prize-value">{g.prizeSummary}</strong>
        {g.winnerCount > 1 && (
          <span className="dim small">{g.winnerCount} winners</span>
        )}
      </div>

      <footer className="giveaway-card-foot">
        <span className="giveaway-entries dim small">
          <strong className="tabular">{g.entryCount.toLocaleString()}</strong>
          {" "}trainer{g.entryCount === 1 ? "" : "s"} entered
        </span>

        {isLive && (
          g.hasEntered ? (
            <span className="giveaway-entered">✓ Entered</span>
          ) : (
            <button className="giveaway-enter" onClick={onEnter} disabled={busy}>
              {busy ? "…" : "Enter"}
            </button>
          )
        )}
      </footer>

      {/* Results stay up. Seeing a real player win is what makes the
          next giveaway feel worth entering. */}
      {drawn && g.winners.length > 0 && (
        <div className="giveaway-winners">
          <span className="giveaway-winners-label">🎉 Winner{g.winners.length === 1 ? "" : "s"}</span>
          <span className="giveaway-winners-list">{g.winners.map((w) => `@${w}`).join(", ")}</span>
          {g.drawSeed && (
            <details className="giveaway-fair">
              <summary className="dim small">Was this fair?</summary>
              <p className="dim small">
                Winners are picked by hashing this draw seed against every entry
                and taking the lowest results — nobody, including us, can change
                the outcome after the seed is set. It's published here so the
                draw can be checked.
              </p>
              <code className="giveaway-seed">{g.drawSeed}</code>
            </details>
          )}
        </div>
      )}

      {isLive && g.minAccountLevel != null && (
        <p className="giveaway-gate dim small">Account level {g.minAccountLevel}+ only</p>
      )}
    </article>
  );
}

// Live countdown. Re-renders each second while a giveaway is closing —
// a deadline you can watch is a deadline you act on.
function Countdown({ to }: { to: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(to).getTime() - Date.now();
  if (ms <= 0) return <span className="giveaway-countdown ended">Closing…</span>;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <span className={`giveaway-countdown ${ms < 3600000 ? "urgent" : ""}`}>
      {d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`} left
    </span>
  );
}
